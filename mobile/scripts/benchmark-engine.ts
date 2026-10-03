import { performance } from 'node:perf_hooks';
import { createPlayer, generateSchedule } from '../src/engine/rotation';
import type { GameInput, PlayerInput } from '../src/engine/models';

type Scenario = {
  name: string;
  game: GameInput;
  players: PlayerInput[];
};

const game: GameInput = {
  total_blocks: 10,
  formation: '4-4-2',
  first_half_gk: 'GK',
  second_half_gk: 'GK',
};

function flexibleRoster(group: PlayerInput['group']): PlayerInput[] {
  return [
    ...Array.from({ length: 15 }, (_, index) => ({
      name: `${group} ${index + 1}`,
      group,
      general_positions: ['D', 'M', 'F'],
      primary_positions: ['ANY'],
    })),
    { name: 'GK', group: 'rotational_gk', general_positions: ['GK'], primary_positions: ['GK'] },
  ];
}

const scenarios: Scenario[] = [
  { name: 'all-flexible', game, players: flexibleRoster('rotational') },
  { name: 'all-core', game, players: flexibleRoster('core') },
  {
    name: 'mixed-flexible',
    game,
    players: [
      ...flexibleRoster('core').filter((player) => player.name !== 'GK').slice(0, 5),
      ...flexibleRoster('rotational').filter((player) => player.name !== 'GK').slice(0, 5),
      ...flexibleRoster('developing').filter((player) => player.name !== 'GK').slice(0, 5),
      { name: 'GK', group: 'rotational_gk', general_positions: ['GK'], primary_positions: ['GK'] },
    ],
  },
  {
    name: 'mixed-primary',
    game,
    players: [
      ...(['core', 'rotational', 'developing'] as const).flatMap((group) => Array.from({ length: 5 }, (_, index) => ({
        name: `${group} primary ${index + 1}`,
        group,
        general_positions: ['D', 'M', 'F'],
        primary_positions: ['D', 'M', 'F'],
      }))),
      { name: 'GK', group: 'rotational_gk', general_positions: ['GK'], primary_positions: ['GK'] },
    ],
  },
];

const iterations = Math.max(1, Number(process.env.BENCHMARK_ITERATIONS ?? 3));

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

for (const scenario of scenarios) {
  const roster = scenario.players.map(createPlayer);
  const warmup = generateSchedule(scenario.game, roster);
  if (warmup.timeline.length !== scenario.game.total_blocks || warmup.timeline.flatMap((block) => Object.values(block.positions)).includes('UNASSIGNED')) {
    throw new Error(`${scenario.name} did not produce a complete schedule`);
  }

  const durations: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const started = performance.now();
    const result = generateSchedule(scenario.game, scenario.players.map(createPlayer));
    durations.push(performance.now() - started);
    if (result.timeline.length !== scenario.game.total_blocks || result.timeline.flatMap((block) => Object.values(block.positions)).includes('UNASSIGNED')) {
      throw new Error(`${scenario.name} did not produce a complete schedule`);
    }
  }

  console.log(`${scenario.name}: median ${median(durations).toFixed(1)} ms; min ${Math.min(...durations).toFixed(1)} ms; max ${Math.max(...durations).toFixed(1)} ms; runs ${durations.length}`);
}
