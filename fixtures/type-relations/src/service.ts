import { ApiClient, BaseService } from "./contracts";

export class UserService extends BaseService implements ApiClient {
  save(): Promise<void> {
    return Promise.resolve();
  }
}
