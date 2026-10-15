"""Plays a few games with a random policy through the Python bridge.

    python python/random_agent.py [nb_games]
"""

import random
import sys
import time

from pac_env import PacEnv


def main():
    nb_games = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    start = time.time()
    decisions = 0
    with PacEnv() as env:
        for game in range(nb_games):
            obs, legal = env.reset()
            done = False
            reward = 0.0
            while not done:
                obs, reward, done, legal = env.step(random.choice(legal))
                decisions += 1
            print(f"game {game + 1}: died at stage {obs['stage']}, reward {reward:.2f}")
    seconds = time.time() - start
    print(f"{nb_games} games, {decisions} decisions in {seconds:.1f}s ({decisions / seconds:.0f} decisions/s)")


if __name__ == "__main__":
    main()
