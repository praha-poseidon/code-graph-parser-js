import UserCard from "@/components/UserCard.jsx";
import { createUser } from "@/api/user";
import { useUser } from "@/hooks/useUser";

export function UserPage() {
  const user = useUser("1");

  function handleCreate() {
    return createUser({ name: "Ada" });
  }

  return <UserCard user={user} onCreate={handleCreate} />;
}
