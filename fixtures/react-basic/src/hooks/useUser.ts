import { getUser } from "@/api/user";

export function useUser(id: string) {
  return getUser(id);
}
