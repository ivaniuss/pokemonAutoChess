/**
 * Headless battle simulator prototype.
 *
 * Runs fights between two fixed boards using the real game Simulation, without
 * Colyseus rooms, network, Firebase or MongoDB, and reports how many fights
 * per second it can run.
 *
 * Usage: npx tsx tools/sim-battle.ts [nbFights]
 */
import Simulation from "../app/core/simulation"
import Player from "../app/models/colyseus-models/player"
import PokemonFactory from "../app/models/pokemon-factory"
import GameState from "../app/rooms/states/game-state"
import type GameRoom from "../app/rooms/game-room"
import { FIGHTING_PHASE_DURATION } from "../app/config"
import { Role } from "../app/types"
import { GameMode } from "../app/types/enum/Game"
import { Pkm } from "../app/types/enum/Pokemon"
import { Weather } from "../app/types/enum/Weather"

const TICK_MS = 50 // same as MAX_SIMULATION_DELTA_TIME in the game server

type BoardSpec = Array<[Pkm, number, number]> // [pokemon, x, y] with y in 1..3

// Minimal stand-in for GameRoom: only what Simulation reaches for during a fight
function createFakeRoom(state: GameState): GameRoom {
  return {
    state,
    clients: [],
    clock: { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) },
    broadcast() {},
    rankPlayers() {},
    computeRoundDamage: () => 0,
    spawnOnBench() {},
    checkEvolutionsAfterPokemonAcquired() {}
  } as unknown as GameRoom
}

function createPlayer(id: string, state: GameState, board: BoardSpec) {
  const player = new Player(
    id,
    id,
    1000,
    0,
    "0001/Normal",
    true,
    1,
    new Map(),
    "",
    Role.BOT,
    state
  )
  for (const [pkm, x, y] of board) {
    const pokemon = PokemonFactory.createPokemonFromName(pkm, player)
    pokemon.positionX = x
    pokemon.positionY = y
    player.board.set(pokemon.id, pokemon)
  }
  return player
}

export type FightResult = {
  winner: "blue" | "red" | "draw"
  durationMs: number
}

export function runFight(blue: BoardSpec, red: BoardSpec): FightResult {
  const state = new GameState(
    "sim",
    "sim",
    true,
    GameMode.CUSTOM_LOBBY,
    null,
    null,
    null
  )
  state.time = FIGHTING_PHASE_DURATION
  const room = createFakeRoom(state)
  const bluePlayer = createPlayer("blue", state, blue)
  const redPlayer = createPlayer("red", state, red)

  const simulation = new Simulation(
    "sim",
    room,
    bluePlayer,
    redPlayer,
    10,
    Weather.NEUTRAL
  )
  bluePlayer.simulationId = simulation.id
  redPlayer.simulationId = simulation.id
  simulation.start()

  let elapsed = 0
  while (!simulation.finished && elapsed < FIGHTING_PHASE_DURATION) {
    simulation.update(TICK_MS)
    state.time -= TICK_MS
    elapsed += TICK_MS
  }

  const winner =
    simulation.winnerId === "blue"
      ? "blue"
      : simulation.winnerId === "red"
        ? "red"
        : "draw"
  return { winner, durationMs: elapsed }
}

const BLUE: BoardSpec = [
  [Pkm.SQUIRTLE, 3, 1],
  [Pkm.CHARMANDER, 4, 1],
  [Pkm.BULBASAUR, 4, 2]
]
const RED: BoardSpec = [
  [Pkm.PIKACHU, 3, 1],
  [Pkm.GEODUDE, 4, 1],
  [Pkm.MACHOP, 4, 2]
]

const BIG_BLUE: BoardSpec = [
  [Pkm.SQUIRTLE, 2, 1],
  [Pkm.CHARMANDER, 3, 1],
  [Pkm.BULBASAUR, 4, 1],
  [Pkm.EEVEE, 5, 1],
  [Pkm.ABRA, 3, 2],
  [Pkm.GASTLY, 4, 2]
]
const BIG_RED: BoardSpec = [
  [Pkm.PIKACHU, 2, 1],
  [Pkm.GEODUDE, 3, 1],
  [Pkm.MACHOP, 4, 1],
  [Pkm.RATTATA, 5, 1],
  [Pkm.ZUBAT, 3, 2],
  [Pkm.ONIX, 4, 2]
]

function benchmark(label: string, blue: BoardSpec, red: BoardSpec, n: number) {
  const first = runFight(blue, red)
  const wins = { blue: 0, red: 0, draw: 0 }
  const start = performance.now()
  for (let i = 0; i < n; i++) wins[runFight(blue, red).winner]++
  const seconds = (performance.now() - start) / 1000
  console.log(
    `${label}: first fight ${first.winner} in ${first.durationMs}ms of game time; ` +
      `${n} fights in ${seconds.toFixed(2)}s -> ${(n / seconds).toFixed(1)} fights/s`,
    wins
  )
}

if (require.main === module) {
  const nbFights = Number(process.argv[2] ?? 20)
  benchmark("3v3", BLUE, RED, nbFights)
  benchmark("6v6", BIG_BLUE, BIG_RED, nbFights)
  process.exit(0) // pending game timers would keep the process alive
}
