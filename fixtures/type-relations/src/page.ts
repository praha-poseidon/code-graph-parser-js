import { UserService } from "./service";

const service = new UserService();

export function handleSave(): Promise<void> {
  return service.save();
}
