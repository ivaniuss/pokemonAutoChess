/**
 * Headless full game: runs a complete game between bots using the real GameRoom
 * logic and commands, without Colyseus networking, Firebase or MongoDB.
 *
 * Usage: npx tsx tools/headless-game.ts [nbBots=8]
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { MAX_SIMULATION_DELTA_TIME } from "../app/config"
import { BotV2 } from "../app/models/mongo-models/bot-v2"
import {
  getAdditionalsTier1
} from "../app/models/precomputed/precomputed-pokemon-data"
import { PRECOMPUTED_POKEMONS_PER_RARITY } from "../app/models/precomputed/precomputed-rarity"
import Player from "../app/models/colyseus-models/player"
import GameRoom from "../app/rooms/game-room"
import { OnUpdateCommand } from "../app/rooms/commands/game-commands"
import GameState from "../app/rooms/states/game-state"
import { Role } from "../app/types"
import { GameMode, Rarity } from "../app/types/enum/Game"
import type { IPokemonCollectionItemForPlayer } from "../app/types/interfaces/UserMetadata"

// The game "bots" replay scripted boards stored in the botv2 collection. Without
// MongoDB we read the same data from db-commands/botv2.json and make BotV2.findOne
// return it, so the real Bot class works unchanged.
type BotScenario = {
  id: string
  name: string
  avatar: string
  elo: number
  approved: boolean
  steps: unknown[]
}
let botScenarios: Map<string, BotScenario> | undefined

function loadBotScenarios(): Map<string, BotScenario> {
  if (!botScenarios) {
    const raw = readFileSync(
      join(__dirname, "..", "db-commands", "botv2.json"),
      "utf8"
    )
    const all = JSON.parse(raw) as BotScenario[]
    botScenarios = new Map(all.filter((b) => b.approved).map((b) => [b.id, b]))
    ;(BotV2 as any).findOne = async (query: { id: string }) =>
      botScenarios!.get(query.id) ?? null
  }
  return botScenarios
}

// Virtual time. The game uses plain setTimeout in a few places (e.g. the pause before
// a fight starts), which would wait real time and never fire in a synchronous loop.
// Here setTimeout/clearTimeout are replaced by a queue driven by the simulated time.
type VirtualTimer = { at: number; fn: () => void; cancelled: boolean }
let virtualTime = 0
let timers: VirtualTimer[] = []

function installVirtualTimers() {
  const g = globalThis as any
  g.setTimeout = (fn: (...a: any[]) => void, ms = 0, ...args: any[]) => {
    const timer: VirtualTimer = {
      at: virtualTime + ms,
      fn: () => fn(...args),
      cancelled: false
    }
    timers.push(timer)
    return Object.assign(timer, {
      unref: () => timer,
      ref: () => timer,
      hasRef: () => false
    })
  }
  g.clearTimeout = (t?: VirtualTimer) => {
    if (t) t.cancelled = true
  }
}

function advanceVirtualTime(deltaTime: number) {
  virtualTime += deltaTime
  const due = timers.filter((t) => t.at <= virtualTime)
  timers = timers.filter((t) => t.at > virtualTime)
  due.sort((a, b) => a.at - b.at).forEach((t) => !t.cancelled && t.fn())
}

/**
 * Builds a GameRoom that never touches the network: the real class is kept so all
 * game methods (spawnOnBench, rankPlayers, ...) and commands work unchanged, and
 * only what depends on Colyseus transport/matchmaking is replaced by no-ops.
 */
export async function createHeadlessGame(
  nbBots = 8,
  gameMode: GameMode = GameMode.CLASSIC
): Promise<GameRoom> {
  const room = new GameRoom() as any
  room.state = new GameState("headless", "headless", true, gameMode, null, null, null)
  room.broadcast = () => {}
  room.setMetadata = async () => {}
  room.disconnect = async () => {}
  room.roomId = "headless"
  room._listing = { metadata: { gameMode } } // backs the metadata accessor

  // virtual clock: game timers (clock.setTimeout) advance with the simulation,
  // not with wall time, so the game can run much faster than real time
  virtualTime = 0
  timers = []
  installVirtualTimers()
  room.clock.now = () => virtualTime
  room.clock.currentTime = 0

  room.miniGame.create(
    room.state.avatars,
    room.state.floatingItems,
    room.state.portals,
    room.state.symbols
  )

  room.additionalUncommonPool = getAdditionalsTier1(
    PRECOMPUTED_POKEMONS_PER_RARITY[Rarity.UNCOMMON]
  )
  room.additionalRarePool = getAdditionalsTier1(
    PRECOMPUTED_POKEMONS_PER_RARITY[Rarity.RARE]
  )
  room.additionalEpicPool = getAdditionalsTier1(
    PRECOMPUTED_POKEMONS_PER_RARITY[Rarity.EPIC]
  )

  const state: GameState = room.state
  const scenarios = [...loadBotScenarios().values()]
  for (let i = 0; i < nbBots; i++) {
    const scenario = scenarios.splice(
      Math.floor(Math.random() * scenarios.length),
      1
    )[0]
    const id = scenario.id
    const player = new Player(
      id,
      scenario.name,
      scenario.elo,
      1,
      scenario.avatar,
      true,
      state.players.size + 1,
      new Map<string, IPokemonCollectionItemForPlayer>(),
      "",
      Role.BOT,
      state
    )
    state.players.set(id, player)
    state.botManager.addBot(player)
  }

  // let the bots finish loading their scripted boards (Bot.initialize is async)
  await new Promise((resolve) => setImmediate(resolve))

  // same as GameRoom.startGame(), without the network timestep
  state.gameLoaded = true
  state.botManager.updateBots()
  room.miniGame.initialize(state, room)
  return room
}

export function stepGame(room: GameRoom, deltaTime = MAX_SIMULATION_DELTA_TIME) {
  if (!room.state.gameFinished && !room.state.simulationPaused) {
    room.dispatcher.dispatch(new OnUpdateCommand(), { deltaTime })
  }
  advanceVirtualTime(deltaTime)
  room.clock.tick()
}

async function playGame(nbBots: number, verbose: boolean) {
  const room = await createHeadlessGame(nbBots)
  let ticks = 0
  let lastStage = -1
  const MAX_TICKS = 2_000_000
  while (!room.state.gameFinished && ticks < MAX_TICKS) {
    stepGame(room)
    ticks++
    if (verbose && room.state.stageLevel !== lastStage) {
      lastStage = room.state.stageLevel
      const alive = [...room.state.players.values()].filter((p) => p.alive).length
      console.log(`stage ${lastStage} phase ${room.state.phase} - ${alive} players alive`)
    }
  }
  const ranking = [...room.state.players.values()].sort((a, b) => a.rank - b.rank)
  return {
    finished: room.state.gameFinished,
    ticks,
    stage: room.state.stageLevel,
    ranking
  }
}

async function main() {
  const nbBots = Number(process.argv[2] ?? 8)
  const nbGames = Number(process.argv[3] ?? 1)
  const start = performance.now()
  let totalTicks = 0
  let unfinished = 0
  let totalStages = 0
  for (let g = 0; g < nbGames; g++) {
    const game = await playGame(nbBots, nbGames === 1)
    totalTicks += game.ticks
    totalStages += game.stage
    if (!game.finished) unfinished++
    if (nbGames === 1) {
      game.ranking.forEach((p) => console.log(`#${p.rank} ${p.name} life=${p.life}`))
    }
  }
  const seconds = (performance.now() - start) / 1000
  console.log(
    `${nbGames} game(s) with ${nbBots} bots in ${seconds.toFixed(1)}s -> ${(nbGames / seconds).toFixed(2)} games/s, ` +
      `average ${(totalTicks / nbGames * MAX_SIMULATION_DELTA_TIME / 60000).toFixed(1)} min and ${(totalStages / nbGames).toFixed(1)} stages of game time, ${unfinished} unfinished`
  )
  process.exit(0)
}

if (require.main === module) {
  main()
}
