import { createControllerApplication } from "./application.js";

/** Called once by the app composition root, with a private authenticated source. */
export async function readApplicationControllerBootstrap(
  application: ReturnType<typeof createControllerApplication>,
) {
  return application.getBootstrap();
}
