"""Fixed-size observation and action spaces on top of PacEnv, ready for RL libraries.

    env = PacGymEnv()
    obs, info = env.reset()
    mask = info["action_mask"]                 # bool array, True = legal
    obs, reward, terminated, truncated, info = env.step(action)   # action in range(env.n_actions)

Actions (integers):
    0                      end turn
    1                      reroll the shop
    2                      level up
    3 .. 3+shop_size-1     buy the unit in that shop slot
    after that, MAX_UNITS  sell the unit in that slot (units sorted by position)

Observation: dict of numpy arrays (Pokemon identities are integer ids, 0 = empty, meant
to go through an embedding layer). Needs numpy, nothing else.
"""

import numpy as np

from pac_env import PacEnv

MAX_UNITS = 24
MAX_OPPONENTS = 7
UNIT_FEATURES = 5


class PacGymEnv:
    def __init__(self, **env_kwargs):
        self._env = PacEnv(**env_kwargs)
        info = self._env.info()
        self.pkm_names = info["pkmNames"]
        self.synergy_names = info["synergyNames"]
        self.shop_size = info["shopSize"]
        self._pkm_id = {name: i + 1 for i, name in enumerate(self.pkm_names)}  # 0 = empty
        self.n_pkm = len(self.pkm_names) + 1
        self.n_actions = 3 + self.shop_size + MAX_UNITS
        self._units = []  # units in the order used by the sell actions
        self._legal = []

    # --- helpers -----------------------------------------------------------------
    def _encode(self, obs: dict) -> dict:
        units = sorted(obs["units"], key=lambda u: (u["y"], u["x"], u["id"]))[:MAX_UNITS]
        self._units = units

        scalars = np.array(
            [
                obs["stage"] / 30,
                obs["money"] / 50,
                obs["life"] / 100,
                obs["level"] / 10,
                obs["exp"] / max(obs["expNeeded"], 1),
                obs["streak"] / 10,
                obs["interest"] / 5,
                len(obs["items"]) / 10,
            ],
            dtype=np.float32,
        )
        shop_pkm = np.zeros(self.shop_size, dtype=np.int64)
        shop_cost = np.zeros(self.shop_size, dtype=np.float32)
        for i, slot in enumerate(obs["shop"][: self.shop_size]):
            if slot:
                shop_pkm[i] = self._pkm_id.get(slot["pkm"], 0)
                shop_cost[i] = slot["cost"] / 10

        unit_pkm = np.zeros(MAX_UNITS, dtype=np.int64)
        unit_feats = np.zeros((MAX_UNITS, UNIT_FEATURES), dtype=np.float32)
        for i, u in enumerate(units):
            unit_pkm[i] = self._pkm_id.get(u["pkm"], 0)
            unit_feats[i] = [u["stars"] / 3, float(u["onBench"]), u["x"] / 7, u["y"] / 4, len(u["items"]) / 3]

        synergies = np.array([obs["synergies"].get(s, 0) / 9 for s in self.synergy_names], dtype=np.float32)
        opponents = np.zeros(MAX_OPPONENTS, dtype=np.float32)
        lives = sorted((max(o["life"], 0) for o in obs["opponents"]), reverse=True)[:MAX_OPPONENTS]
        opponents[: len(lives)] = np.array(lives, dtype=np.float32) / 100

        return {
            "scalars": scalars,
            "shop_pkm": shop_pkm,
            "shop_cost": shop_cost,
            "unit_pkm": unit_pkm,
            "unit_feats": unit_feats,
            "synergies": synergies,
            "opponents_life": opponents,
        }

    def _mask(self, legal: list) -> np.ndarray:
        mask = np.zeros(self.n_actions, dtype=bool)
        sell_ids = {u["id"]: i for i, u in enumerate(self._units)}
        for a in legal:
            kind = a["type"]
            if kind == "endTurn":
                mask[0] = True
            elif kind == "reroll":
                mask[1] = True
            elif kind == "levelUp":
                mask[2] = True
            elif kind == "buy":
                mask[3 + a["index"]] = True
            elif kind == "sell" and a["pokemonId"] in sell_ids:
                mask[3 + self.shop_size + sell_ids[a["pokemonId"]]] = True
        return mask

    def _to_action(self, action: int) -> dict:
        if action == 0:
            return {"type": "endTurn"}
        if action == 1:
            return {"type": "reroll"}
        if action == 2:
            return {"type": "levelUp"}
        if action < 3 + self.shop_size:
            return {"type": "buy", "index": action - 3}
        return {"type": "sell", "pokemonId": self._units[action - 3 - self.shop_size]["id"]}

    # --- Gymnasium-style API -----------------------------------------------------
    def reset(self):
        obs, legal = self._env.reset()
        self._legal = legal
        encoded = self._encode(obs)
        return encoded, {"action_mask": self._mask(legal), "stage": obs["stage"]}

    def step(self, action: int):
        action = int(action)
        if not self._mask(self._legal)[action]:
            raise ValueError(f"Illegal action {action}")
        obs, reward, done, legal = self._env.step(self._to_action(action))
        self._legal = legal
        encoded = self._encode(obs)
        info = {"action_mask": self._mask(legal), "stage": obs["stage"]}
        return encoded, float(reward), bool(done), False, info

    def close(self):
        self._env.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
