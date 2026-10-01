import type { Db } from "./db";

export interface PositionRow {
  pos_id: string;
  owner: string;
  adapter: string;
  target: string;
  token_id: string;
  active: boolean;
  epoch: string;
}
