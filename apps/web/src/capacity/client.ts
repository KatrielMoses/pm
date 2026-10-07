import { api, protectedRequest, type StepUpResolver } from '../api.ts';

/** Typed client for the 3E capacity API (ADR-0022). Every identifier is a public ID. */

export interface Window {
  weekday: number;
  start: string;
  end: string;
}

export interface CapacityProfile {
  timezone: string;
  windows: Window[];
  nominal_week_minutes: number;
  weekly_capacity_minutes: number | null;
  effective_week_minutes: number;
  observe_brand_holidays: boolean;
  configured: boolean;
  version: number;
}

export interface TimeOff {
  id: string;
  kind: 'vacation' | 'sick' | 'personal' | 'holiday' | 'unavailable';
  all_day: boolean;
  starts_on: string | null;
  ends_on: string | null;
  starts_at: string | null;
  ends_at: string | null;
  tz: string;
  label: string | null;
  version: number;
}

export interface Allocation {
  available: number;
  planned: number;
  over: number;
  under: number;
  state: 'over' | 'under' | 'ok';
}

export interface CapacityDay extends Allocation {
  day: string;
  weekday: number;
  working_minutes: number;
  unavailable_minutes: number;
  available_minutes: number;
  holiday: boolean;
  scheduled_minutes: number;
  estimated_minutes: number;
  unestimated_tasks: number;
}

export type Conflict =
  | { kind: 'overlap'; at: string; minutes: number; blocks: string[]; brands: string[] }
  | { kind: 'reservation_unmet'; brand: string; reserved_minutes: number; room_minutes: number };

export interface Capacity {
  member: { id: string; name: string; self: boolean };
  timezone: string;
  from: string;
  to: string;
  days: CapacityDay[];
  totals: Allocation & {
    days: number;
    available_minutes: number;
    scheduled_minutes: number;
    estimated_minutes: number;
    reserved_minutes: number;
  };
  brands: Array<{
    brand: { id: string; name: string };
    reserved_minutes: number;
    scheduled_minutes: number;
    estimated_minutes: number;
    over_reservation_minutes: number;
  }>;
  conflicts: Conflict[];
}

export interface TeamCapacity {
  from: string;
  to: string;
  truncated: boolean;
  people: Array<{
    member: { id: string; name: string; self: boolean };
    totals: Capacity['totals'];
    conflicts: number;
  }>;
}

export interface Reservation {
  id: string;
  brand: { id: string; name: string };
  member: { id: string; name: string };
  minutes_per_week: number;
  effective_from: string;
  effective_to: string | null;
  version: number;
}

export interface Holiday {
  id: string;
  day: string;
  name: string;
}

const w = (ws: string) => `/v1/workspaces/${ws}`;
const range = (from: string, to: string) => `from=${from}&to=${to}`;

export const capacity = {
  async profile(ws: string) {
    return (await api<{ data: CapacityProfile }>('GET', `${w(ws)}/me/capacity-profile`)).body.data;
  },
  async setProfile(
    ws: string,
    version: number,
    body: Record<string, unknown>,
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: CapacityProfile }>(
        'PUT',
        `${w(ws)}/me/capacity-profile`,
        body,
        stepUp,
        { ifMatch: version },
      )
    ).body.data;
  },
  async mine(ws: string, from: string, to: string, member?: string) {
    return (
      await api<{ data: Capacity }>(
        'GET',
        `${w(ws)}/capacity?${range(from, to)}${member ? `&member=${member}` : ''}`,
      )
    ).body.data;
  },
  async team(ws: string, from: string, to: string) {
    return (await api<{ data: TeamCapacity }>('GET', `${w(ws)}/capacity/team?${range(from, to)}`))
      .body.data;
  },
  async timeOff(ws: string) {
    return (await api<{ data: TimeOff[] }>('GET', `${w(ws)}/me/time-off`)).body.data;
  },
  async addTimeOff(ws: string, body: Record<string, unknown>, stepUp: StepUpResolver) {
    return (await protectedRequest<{ data: TimeOff }>('POST', `${w(ws)}/me/time-off`, body, stepUp))
      .body.data;
  },
  async removeTimeOff(ws: string, id: string, version: number, stepUp: StepUpResolver) {
    await protectedRequest('DELETE', `${w(ws)}/me/time-off/${id}`, {}, stepUp, {
      ifMatch: version,
    });
  },
  async reservations(ws: string) {
    return (await api<{ data: Reservation[] }>('GET', `${w(ws)}/capacity-reservations`)).body.data;
  },
  async reserve(ws: string, body: Record<string, unknown>, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: Reservation }>(
        'POST',
        `${w(ws)}/capacity-reservations`,
        body,
        stepUp,
      )
    ).body.data;
  },
  async unreserve(ws: string, id: string, version: number, stepUp: StepUpResolver) {
    await protectedRequest('DELETE', `${w(ws)}/capacity-reservations/${id}`, {}, stepUp, {
      ifMatch: version,
    });
  },
  async holidays(ws: string, brand: string) {
    return (
      await api<{ data: Holiday[]; can_configure: boolean }>(
        'GET',
        `${w(ws)}/brands/${brand}/holidays`,
      )
    ).body;
  },
  async addHoliday(
    ws: string,
    brand: string,
    body: Record<string, unknown>,
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: Holiday }>(
        'POST',
        `${w(ws)}/brands/${brand}/holidays`,
        body,
        stepUp,
      )
    ).body.data;
  },
  async removeHoliday(ws: string, brand: string, id: string, stepUp: StepUpResolver) {
    await protectedRequest('DELETE', `${w(ws)}/brands/${brand}/holidays/${id}`, {}, stepUp);
  },
};

/** Whole minutes as `7 h 30 min`, `45 min`, or `0 h`. */
export const hours = (m: number) => {
  const h = Math.floor(Math.abs(m) / 60);
  const r = Math.abs(m) % 60;
  return `${m < 0 ? '−' : ''}${h ? `${h} h` : ''}${h && r ? ' ' : ''}${r || !h ? `${r} min` : ''}`;
};
export const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];
