const API_PREFIX = "/api";

export function getUser(id: string) {
  return request.get(`${API_PREFIX}/users/${id}`);
}

export function createUser(payload: unknown) {
  return fetch("/api/users", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}
