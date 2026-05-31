function Controller(_path: string) {
  return () => undefined;
}

function Get(_path: string) {
  return () => undefined;
}

@Controller("/admin")
export class AdminController {
  @Get("/users")
  list() {
    return "ok";
  }
}
