# Python bridge for training agents

`pac_env.py` starts `tools/env-server.ts` (the real game rules running headless) and
exposes it as a small Python class. It only uses the standard library, so it works
before installing any machine learning package.

```python
from pac_env import PacEnv

with PacEnv() as env:
    obs, legal = env.reset()             # new game, 1 agent + 7 scripted bots
    done = False
    while not done:
        action = legal[0]                # e.g. {"type": "buy", "index": 0}
        obs, reward, done, legal = env.step(action)
```

Try it: `cd python && python random_agent.py 3`

- Actions: `buy` (shop index), `reroll`, `levelUp`, `sell` (unit id) and `endTurn`.
  Only the legal ones are returned in `legal`.
- Reward is 0 during the game and, at the end, the final placement mapped to [-1, 1].
- One `PacEnv` is one game process. For parallel training start several of them.
- Set `PAC_ENV_DEBUG=1` to see the game logs on stderr.
