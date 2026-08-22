export interface ApiClient {
  save(): Promise<void>;
}

export class BaseService {
  log(): void {}
}
