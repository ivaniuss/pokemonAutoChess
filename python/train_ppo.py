"""Minimal PPO with action masking, trained against the scripted bots.

    .venv/Scripts/python python/train_ppo.py [total_games=200] [nb_envs=4]

Uses PacGymEnv (see pac_gym.py): one game process per environment, stepped in turn.
Prints the average placement reward (1.0 = always first, -1.0 = always last) and the average
stage reached, which is also rewarded so there is a learning signal before winning.
"""

import sys
import time
from collections import deque

import numpy as np
import torch
import torch.nn as nn

from pac_gym import MAX_UNITS, MAX_OPPONENTS, UNIT_FEATURES, PacGymEnv

EMBED = 16
HIDDEN = 128


class Policy(nn.Module):
    def __init__(self, n_pkm: int, n_synergies: int, shop_size: int, n_actions: int):
        super().__init__()
        self.embed = nn.Embedding(n_pkm, EMBED, padding_idx=0)
        in_size = (
            8  # scalars
            + shop_size * (EMBED + 1)
            + MAX_UNITS * (EMBED + UNIT_FEATURES)
            + n_synergies
            + MAX_OPPONENTS
        )
        self.body = nn.Sequential(nn.Linear(in_size, HIDDEN * 2), nn.ReLU(), nn.Linear(HIDDEN * 2, HIDDEN), nn.ReLU())
        self.actor = nn.Linear(HIDDEN, n_actions)
        self.critic = nn.Linear(HIDDEN, 1)

    def features(self, obs: dict) -> torch.Tensor:
        b = obs["scalars"].shape[0]
        shop = torch.cat([self.embed(obs["shop_pkm"]), obs["shop_cost"].unsqueeze(-1)], dim=-1).reshape(b, -1)
        units = torch.cat([self.embed(obs["unit_pkm"]), obs["unit_feats"]], dim=-1).reshape(b, -1)
        x = torch.cat([obs["scalars"], shop, units, obs["synergies"], obs["opponents_life"]], dim=-1)
        return self.body(x)

    def forward(self, obs: dict, mask: torch.Tensor):
        h = self.features(obs)
        logits = self.actor(h).masked_fill(~mask, -1e9)
        return torch.distributions.Categorical(logits=logits), self.critic(h).squeeze(-1)


def to_tensor(obs_list: list) -> dict:
    keys = obs_list[0].keys()
    return {k: torch.as_tensor(np.stack([o[k] for o in obs_list])) for k in keys}


def main():
    total_games = int(sys.argv[1]) if len(sys.argv) > 1 else 200
    nb_envs = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    torch.manual_seed(0)

    envs = [PacGymEnv() for _ in range(nb_envs)]
    e0 = envs[0]
    policy = Policy(e0.n_pkm, len(e0.synergy_names), e0.shop_size, e0.n_actions)
    optimizer = torch.optim.Adam(policy.parameters(), lr=3e-4)

    obs = []
    masks = []
    prev_life = []  # normalized life (1.0 = full) after the previous step, per environment
    for env in envs:
        o, info = env.reset()
        obs.append(o)
        masks.append(info["action_mask"])
        prev_life.append(float(o["scalars"][2]))

    ROLLOUT, EPOCHS, CLIP, GAMMA, LAM, ENTROPY = 128, 4, 0.2, 1.0, 0.95, 0.01
    LIFE_WEIGHT = 2.0  # losing all life in one step would cost 2.0
    results = deque(maxlen=50)  # final placement reward of recent games
    stages = deque(maxlen=50)  # stage reached in recent games
    games_done = 0
    start = time.time()

    while games_done < total_games:
        storage = {k: [] for k in ("obs", "mask", "action", "logp", "value", "reward", "done")}
        for _ in range(ROLLOUT):
            t_obs, t_mask = to_tensor(obs), torch.as_tensor(np.stack(masks))
            with torch.no_grad():
                dist, value = policy(t_obs, t_mask)
                action = dist.sample()
                logp = dist.log_prob(action)
            rewards, dones = [], []
            for i, env in enumerate(envs):
                o, r, terminated, _, info = env.step(int(action[i]))
                if terminated:
                    results.append(r)
                    stages.append(info["stage"])
                    games_done += 1
                    # the placement alone is -1 for any agent that finishes last, which gives
                    # no learning signal; surviving more stages is rewarded on top of it
                    r = r + info["stage"] / 30
                    o, info = env.reset()
                    prev_life[i] = float(o["scalars"][2])
                else:
                    # dense signal: life lost in the fights since the previous step
                    life = float(o["scalars"][2])
                    r = LIFE_WEIGHT * (life - prev_life[i])
                    prev_life[i] = life
                obs[i], masks[i] = o, info["action_mask"]
                rewards.append(r)
                dones.append(float(terminated))
            storage["obs"].append(t_obs)
            storage["mask"].append(t_mask)
            storage["action"].append(action)
            storage["logp"].append(logp)
            storage["value"].append(value)
            storage["reward"].append(torch.tensor(rewards, dtype=torch.float32))
            storage["done"].append(torch.tensor(dones, dtype=torch.float32))

        with torch.no_grad():
            _, last_value = policy(to_tensor(obs), torch.as_tensor(np.stack(masks)))
        # generalized advantage estimation
        advantages = torch.zeros(ROLLOUT, nb_envs)
        gae = torch.zeros(nb_envs)
        for t in reversed(range(ROLLOUT)):
            next_value = last_value if t == ROLLOUT - 1 else storage["value"][t + 1]
            not_done = 1.0 - storage["done"][t]
            delta = storage["reward"][t] + GAMMA * next_value * not_done - storage["value"][t]
            gae = delta + GAMMA * LAM * not_done * gae
            advantages[t] = gae
        values = torch.stack(storage["value"])
        returns = advantages + values

        flat_obs = {k: torch.cat([s[k] for s in storage["obs"]]) for k in storage["obs"][0]}
        flat_mask = torch.cat(storage["mask"])
        flat_action = torch.cat(storage["action"])
        flat_logp = torch.cat(storage["logp"])
        flat_adv = advantages.reshape(-1)
        flat_adv = (flat_adv - flat_adv.mean()) / (flat_adv.std() + 1e-8)
        flat_ret = returns.reshape(-1)

        n = flat_action.shape[0]
        for _ in range(EPOCHS):
            for idx in torch.randperm(n).split(256):
                dist, value = policy({k: v[idx] for k, v in flat_obs.items()}, flat_mask[idx])
                ratio = (dist.log_prob(flat_action[idx]) - flat_logp[idx]).exp()
                unclipped = ratio * flat_adv[idx]
                clipped = ratio.clamp(1 - CLIP, 1 + CLIP) * flat_adv[idx]
                loss = (
                    -torch.min(unclipped, clipped).mean()
                    + 0.5 * (value - flat_ret[idx]).pow(2).mean()
                    - ENTROPY * dist.entropy().mean()
                )
                optimizer.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(policy.parameters(), 0.5)
                optimizer.step()

        if results:
            print(
                f"games {games_done:4d}  placement reward {np.mean(results):+.2f}  "
                f"avg stage {np.mean(stages):.1f}  "
                f"elapsed {time.time() - start:.0f}s",
                flush=True,
            )

    torch.save(policy.state_dict(), "pac_policy.pt")
    for env in envs:
        env.close()


if __name__ == "__main__":
    main()
