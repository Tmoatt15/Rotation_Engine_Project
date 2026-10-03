import type { Formation, GameFormat, SeasonSettings } from './models';

export const BLOCK_ROUNDING_SECONDS = 30;

export const GAME_FORMATS: Record<GameFormat, { players_on_field: number; has_goalkeeper: boolean; default_formation: Formation }> = {
  '4v4': { players_on_field: 4, has_goalkeeper: false, default_formation: '1-2-1' },
  '5v5': { players_on_field: 5, has_goalkeeper: true, default_formation: '1-2-1' },
  '7v7': { players_on_field: 7, has_goalkeeper: true, default_formation: '2-3-1' },
  '9v9': { players_on_field: 9, has_goalkeeper: true, default_formation: '3-3-2' },
  '11v11': { players_on_field: 11, has_goalkeeper: true, default_formation: '4-4-2' },
};

export const FORMATIONS_BY_FORMAT: Record<GameFormat, Formation[]> = {
  '4v4': ['1-2-1', '2-0-2'],
  '5v5': ['1-2-1', '2-0-2', '2-1-1'],
  '7v7': ['2-3-1', '3-2-1', '2-1-2-1'],
  '9v9': ['3-3-2', '3-4-1', '4-3-1'],
  '11v11': ['4-3-3', '4-4-2', '4-2-3-1', '3-4-3'],
};

export function formatBlockLength(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

export class SeasonSetup {
  readonly game_length_minutes: number;
  readonly game_format: GameFormat;
  readonly total_blocks: number;
  readonly base_block_seconds: number;
  readonly block_seconds: number[];
  readonly block_length_minutes: number;
  readonly formation: Formation;
  readonly total_games: number;
  readonly substitution_alert: SeasonSettings['substitution_alert'];
  readonly substitution_warning_seconds: 15 | 30 | 60;
  readonly players_on_field: number;
  readonly has_goalkeeper: boolean;

  constructor(settings: Pick<SeasonSettings, 'game_length_minutes' | 'game_format'> & Partial<SeasonSettings> & { total_blocks?: number; block_length_minutes?: number }) {
    if (settings.game_length_minutes <= 0) throw new Error('Game length must be greater than zero minutes.');
    const gameFormat = String(settings.game_format).trim().toLowerCase().replace(/ /g, '') as GameFormat;
    if (!(gameFormat in GAME_FORMATS)) throw new Error(`Game format must be one of: ${Object.keys(GAME_FORMATS).join(', ')}.`);
    if ((settings.total_blocks == null) === (settings.block_length_minutes == null)) throw new Error('Provide either total_blocks or block_length_minutes, not both.');
    const totalSeconds = Math.round(settings.game_length_minutes * 60);
    let totalBlocks: number;
    let baseSeconds: number;
    if (settings.total_blocks != null) {
      if (settings.total_blocks <= 0) throw new Error('Number of blocks must be greater than zero.');
      totalBlocks = Math.trunc(settings.total_blocks);
      baseSeconds = Math.floor(totalSeconds / totalBlocks / BLOCK_ROUNDING_SECONDS) * BLOCK_ROUNDING_SECONDS;
    } else {
      if ((settings.block_length_minutes ?? 0) <= 0) throw new Error('Block length must be greater than zero minutes.');
      if ((settings.block_length_minutes ?? 0) > settings.game_length_minutes) throw new Error('Block length cannot exceed the game length.');
      baseSeconds = Math.round((settings.block_length_minutes ?? 0) * 60);
      totalBlocks = Math.floor(totalSeconds / baseSeconds);
    }
    if (baseSeconds < BLOCK_ROUNDING_SECONDS) throw new Error(`${totalBlocks} blocks would be shorter than ${BLOCK_ROUNDING_SECONDS} seconds each.`);
    const surplus = totalSeconds - baseSeconds * totalBlocks;
    const halfLength = Math.ceil(totalBlocks / 2);
    const blockSeconds = Array.from({ length: totalBlocks }, () => baseSeconds);
    if (surplus > 0) {
      const first = Math.floor(surplus / 2);
      blockSeconds[halfLength - 1] += first;
      blockSeconds[totalBlocks - 1] += surplus - first;
    }
    const alert = settings.substitution_alert ?? 'flash_and_vibrate';
    if (!['none', 'flash', 'vibrate', 'flash_and_vibrate'].includes(alert)) throw new Error('Substitution alert must be none, flash, vibrate, or flash_and_vibrate.');
    const warning = settings.substitution_warning_seconds ?? 30;
    if (![15, 30, 60].includes(warning)) throw new Error('Substitution warning must be 15, 30, or 60 seconds.');
    const details = GAME_FORMATS[gameFormat];
    this.game_length_minutes = settings.game_length_minutes;
    this.game_format = gameFormat;
    this.total_blocks = totalBlocks;
    this.base_block_seconds = baseSeconds;
    this.block_seconds = blockSeconds;
    this.block_length_minutes = Math.round(baseSeconds / 60 * 100) / 100;
    this.formation = settings.formation ?? details.default_formation;
    this.total_games = settings.total_games ?? 1;
    this.substitution_alert = alert;
    this.substitution_warning_seconds = warning;
    this.players_on_field = details.players_on_field;
    this.has_goalkeeper = details.has_goalkeeper;
  }

  get field_players(): number { return this.players_on_field - (this.has_goalkeeper ? 1 : 0); }
  get blocks_divide_evenly(): boolean { return this.block_seconds.every((seconds) => seconds === this.base_block_seconds); }
  get block_lengths_minutes(): number[] { return this.block_seconds.map((seconds) => seconds / 60); }
  get extended_block_numbers(): number[] { return this.block_seconds.reduce<number[]>((extended, seconds, index) => seconds === this.base_block_seconds ? extended : [...extended, index + 1], []); }
  get formation_options(): Formation[] { return FORMATIONS_BY_FORMAT[this.game_format]; }

  validate_formation(): string | null {
    if (!this.formation_options.includes(this.formation)) return `Formation ${this.formation} is not available for ${this.game_format}. Choose: ${this.formation_options.join(', ')}.`;
    const parts = this.formation.split('-');
    const validCounts = this.game_format === '5v5' ? [2, 3] : this.game_format === '7v7' || this.game_format === '11v11' ? [3, 4] : [3];
    if (!validCounts.includes(parts.length) || parts.some((part) => !/^\d+$/.test(part))) return `Formation must be in the correct format, for example ${this.game_format === '5v5' ? '2-2 or 1-2-1' : '4-4-2'}.`;
    const total = parts.reduce((sum, part) => sum + Number(part), 0);
    return total === this.field_players ? null : `Formation ${this.formation} uses ${total} field players but ${this.game_format} needs ${this.field_players}.`;
  }
}
