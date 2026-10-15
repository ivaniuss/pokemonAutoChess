"""Smoke test for PacGymEnv: plays games choosing a random legal action by its integer id.

    python python/masked_random.py [nb_games]
"""

import sys
import time

import numpy as np

from pac_gym import PacGymEnv


def main():
    nb_games = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    rng = np.random.default_rng()
    start = time.time()
    decisions = 0
    with PacGymEnv() as env:
        print(f"{env.n_actions} actions, {env.n_pkm} Pokemon ids, {len(env.synergy_names)} synergies")
        for game in range(nb_games):
            obs, info = env.reset()
            terminated = False
            reward = 0.0
            while not terminated:
                action = rng.choice(np.flatnonzero(info["action_mask"]))
                obs, reward, terminated, truncated, info = env.step(action)
                decisions += 1
            print(f"game {game + 1}: died at stage {info['stage']}, reward {reward:.2f}")
        print("observation shapes:", {k: v.shape for k, v in obs.items()})
    seconds = time.time() - start
    print(f"{nb_games} games, {decisions} decisions in {seconds:.1f}s ({decisions / seconds:.0f} decisions/s)")


if __name__ == "__main__":
    main()
