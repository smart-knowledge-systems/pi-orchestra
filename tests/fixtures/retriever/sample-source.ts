import { resolve } from 'node:path';

export const MAX_RETRIES = 3;

export type UserId = string;

export interface UserConfig {
  name: string;
  email: string;
  active: boolean;
}

export function createUser(config: UserConfig): { id: UserId } {
  return { id: 'user_001' };
}

export async function fetchUser(id: UserId): Promise<UserConfig | null> {
  if (!id) return null;
  return { name: 'Test', email: 'test@example.com', active: true };
}

export class UserService {
  private users: Map<string, UserConfig> = new Map();

  add(id: string, config: UserConfig): void {
    this.users.set(id, config);
  }

  get(id: string): UserConfig | undefined {
    return this.users.get(id);
  }

  listAll(): UserConfig[] {
    return Array.from(this.users.values());
  }
}

export abstract class BaseRepository {
  abstract find(id: string): Promise<unknown>;
  abstract save(entity: unknown): Promise<void>;
}
