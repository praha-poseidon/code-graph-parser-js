const router = {
  get(_path: string, _handler: unknown) {}
};

const kafka = {
  send(_topic: string, _payload: unknown) {}
};

const redis = {
  get(_key: string) {}
};

const db = {
  query(_sql: string) {}
};

export function listUsers() {
  fetch("/api/users");
  axios.post("/api/users");
  kafka.send("users.created", {});
  redis.get("user:*");
  db.query("select * from users where id = ?");
}

export function handleClick() {
  return fetch("/api/click");
}

router.get("/users/:id", listUsers);

export function Page() {
  return (
    <>
      <button onClick={handleClick}>Save User</button>
      <a onClick={handleClick}>Open User</a>
      <input name="Search User" onChange={handleClick} />
      <form name="User Form" onSubmit={handleClick}></form>
    </>
  );
}
