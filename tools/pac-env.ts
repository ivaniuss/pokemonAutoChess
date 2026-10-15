/**
 * Reinforcement-learning style environment for Pokemon Auto Chess.
 *
 * One controlled player (the agent) plays a full game against scripted bots,
 * using the real game commands. The agent acts during the PICK phase and every
 * other phase (fights, town) is simulated automatically.
 *
 *   const env = await PacEnv.create()
 *   while (!env.done) env.step(pickOne(env.legalActions()))
 *
 * Run `npx tsx tools/pac-env.ts [nbGames=5] [random|greedy]` to play with a baseline policy.
 */
import type { Dispatcher } from "@colyseus/command"
import { canSell } from "../app/core/pokemon-entity"
import { getLevelUpCost } from "../app/models/colyseus-models/experience-manager"
import type Player from "../app/models/colyseus-models/player"
import { getBuyPrice } from "../app/models/shop"
import {
  OnBuyPokemonCommand,
  OnLevelUpCommand,
  OnSellPokemonCommand,
  OnShopRerollCommand
} from "../app/rooms/commands/game-commands"
import type GameRoom from "../app/rooms/game-room"
import { GamePhaseState } from "../app/types/enum/Game"
import { Pkm } from "../app/types/enum/Pokemon"
import { getFreeSpaceOnBench } from "../app/utils/board"
import { createHeadlessGame, stepGame } from "./headless-game"

export type Action =
  | { type: "buy"; index: number }
  | { type: "reroll" }
  | { type: "levelUp" }
  | { type: "sell"; pokemonId: string }
  | { type: "endTurn" }

export type Observation = {
  stage: number
  money: number
  life: number
  level: number
  exp: number
  expNeeded: number
  streak: number
  interest: number
  shop: Array<{ pkm: string; cost: number } | null>
  units: Array<{
    id: string
    pkm: string
    stars: number
    x: number
    y: number
    onBench: boolean
    items: string[]
  }>
  items: string[]
  synergies: Record<string, number>
  opponents: Array<{ id: string; life: number; alive: boolean }>
}

const MAX_TICKS_PER_TURN = 200_000 // safety net against a stuck game

export class PacEnv {
  readonly agentId = "agent"
  readonly nbPlayers: number
  room!: GameRoom
  done = false
  private client = { auth: { uid: this.agentId }, userData: {}, send() {} }
  private dispatcher!: Dispatcher<GameRoom>

  private constructor(nbPlayers: number) {
    this.nbPlayers = nbPlayers
  }

  static async create(nbPlayers = 8): Promise<PacEnv> {
    const env = new PacEnv(nbPlayers)
    await env.reset()
    return env
  }

  get player(): Player {
    return this.room.state.players.get(this.agentId)!
  }

  async reset(): Promise<Observation> {
    this.room = await createHeadlessGame(this.nbPlayers - 1, undefined, [
      this.agentId
    ])
    this.dispatcher = this.room.dispatcher
    this.done = false
    this.advanceToNextPickPhase()
    return this.observation()
  }

  /** Simulates fights and town phases until the agent can act again, or the game ends */
  private advanceToNextPickPhase() {
    const { state } = this.room
    let previousPhase = state.phase
    for (let ticks = 0; ticks < MAX_TICKS_PER_TURN; ticks++) {
      stepGame(this.room)
      if (state.gameFinished || !this.player.alive) {
        this.done = true
        return
      }
      const enteredPick =
        state.phase === GamePhaseState.PICK &&
        previousPhase !== GamePhaseState.PICK
      previousPhase = state.phase
      if (enteredPick && !state.simulationPaused) return
    }
    throw new Error("Game did not reach the next pick phase")
  }

  observation(): Observation {
    const { state } = this.room
    const player = this.player
    const rule = state.specialGameRule
    const synergies: Record<string, number> = {}
    player.synergies.forEach((value, key) => {
      if (value > 0) synergies[key] = value
    })
    return {
      stage: state.stageLevel,
      money: player.money,
      life: player.life,
      level: player.experienceManager.level,
      exp: player.experienceManager.experience,
      expNeeded: player.experienceManager.expNeeded,
      streak: player.streak,
      interest: player.interest,
      shop: player.shop.map((pkm) =>
        pkm && pkm !== Pkm.DEFAULT
          ? { pkm, cost: getBuyPrice(pkm, rule) }
          : null
      ),
      units: [...player.board.values()].map((p) => ({
        id: p.id,
        pkm: p.name,
        stars: p.stars,
        x: p.positionX,
        y: p.positionY,
        onBench: p.positionY === 0,
        items: [...p.items]
      })),
      items: [...player.items],
      synergies,
      opponents: [...state.players.values()]
        .filter((p) => p.id !== this.agentId)
        .map((p) => ({ id: p.id, life: p.life, alive: p.alive }))
    }
  }

  legalActions(): Action[] {
    if (this.done || this.room.state.phase !== GamePhaseState.PICK) return []
    const player = this.player
    const rule = this.room.state.specialGameRule
    const actions: Action[] = [{ type: "endTurn" }]

    const freeBench = getFreeSpaceOnBench(player.board)
    player.shop.forEach((pkm, index) => {
      if (!pkm || pkm === Pkm.DEFAULT) return
      if (freeBench > 0 && player.money >= getBuyPrice(pkm, rule)) {
        actions.push({ type: "buy", index })
      }
    })
    if (player.money >= (player.shopFreeRolls > 0 ? 0 : 1)) {
      actions.push({ type: "reroll" })
    }
    if (
      player.experienceManager.canLevelUp() &&
      player.money >= getLevelUpCost(rule)
    ) {
      actions.push({ type: "levelUp" })
    }
    for (const pokemon of player.board.values()) {
      if (canSell(pokemon.name, rule)) {
        actions.push({ type: "sell", pokemonId: pokemon.id })
      }
    }
    return actions
  }

  step(action: Action): {
    observation: Observation
    reward: number
    done: boolean
  } {
    if (this.done) throw new Error("Game is over, call reset()")
    switch (action.type) {
      case "buy":
        this.dispatcher.dispatch(new OnBuyPokemonCommand(), {
          playerId: this.agentId,
          index: action.index
        })
        break
      case "reroll":
        this.dispatcher.dispatch(new OnShopRerollCommand(), this.agentId)
        break
      case "levelUp":
        this.dispatcher.dispatch(new OnLevelUpCommand(), this.agentId)
        break
      case "sell":
        this.dispatcher.dispatch(new OnSellPokemonCommand(), {
          client: this.client as any,
          pokemonId: action.pokemonId
        })
        break
      case "endTurn":
        this.advanceToNextPickPhase()
        break
    }
    return {
      observation: this.observation(),
      reward: this.done ? this.finalReward() : 0,
      done: this.done
    }
  }

  /** Placement mapped to [-1, 1]: 1st place = +1, last place = -1 */
  finalReward(): number {
    const rank = this.player.alive ? 1 : this.player.rank
    return 1 - (2 * (rank - 1)) / (this.nbPlayers - 1)
  }
}

// Simple hand-written baseline: buy whatever is affordable, then level up, then end the turn
function greedyPolicy(actions: Action[]): Action {
  return (
    actions.find((a) => a.type === "buy") ??
    actions.find((a) => a.type === "levelUp") ??
    actions.find((a) => a.type === "endTurn")!
  )
}

function randomPolicy(actions: Action[]): Action {
  return actions[Math.floor(Math.random() * actions.length)]
}

async function main() {
  const nbGames = Number(process.argv[2] ?? 5)
  const policy = process.argv[3] === "greedy" ? greedyPolicy : randomPolicy
  const start = performance.now()
  const ranks: number[] = []
  let decisions = 0
  for (let g = 0; g < nbGames; g++) {
    const env = await PacEnv.create()
    while (!env.done) {
      env.step(policy(env.legalActions()))
      decisions++
    }
    ranks.push(env.player.rank)
    console.log(
      `game ${g + 1}: placed #${env.player.rank}/${env.nbPlayers}, died at stage ${env.room.state.stageLevel}, reward ${env.finalReward().toFixed(2)}`
    )
  }
  const seconds = (performance.now() - start) / 1000
  console.log(
    `${nbGames} games, ${decisions} decisions in ${seconds.toFixed(1)}s ` +
      `(${(decisions / seconds).toFixed(0)} decisions/s), average rank ${(ranks.reduce((a, b) => a + b, 0) / ranks.length).toFixed(2)}`
  )
  process.exit(0)
}

if (require.main === module) {
  main()
}
