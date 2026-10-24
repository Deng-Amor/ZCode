import { app } from "electron";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { applyEarlyDataBaseDirBootstrap } from "./desktopDataBaseDirBootstrap.js";

// 原版和品牌版默认共享 ~/.zcode 会覆盖账号与设置；在任何服务导入前建立独立根目录。
// 开发态保留启动器传入的隔离环境，正式包无需用户设置环境变量。
if (app?.isPackaged) {
  const brandDirectory = app.getName().includes("Preview") ? "CCode Preview" : "CCode";
  const homeDirectory = join(app.getPath("appData"), brandDirectory, "data");
  process.env.ZCODE_DESKTOP_HOME_DIR = homeDirectory;
  process.env.ZCODE_DATA_BASE_DIR = homeDirectory;
}

applyEarlyDataBaseDirBootstrap();
if (app?.isPackaged && process.env.ZCODE_DATA_BASE_DIR) {
  // 旧设置若指向真实 HOME，不能把品牌实例重新接回原版共享目录。
  if (resolve(process.env.ZCODE_DATA_BASE_DIR) === resolve(homedir())) {
    process.env.ZCODE_DATA_BASE_DIR = process.env.ZCODE_DESKTOP_HOME_DIR!;
  }
  const root = join(process.env.ZCODE_DATA_BASE_DIR, ".zcode");
  process.env.ZCODE_HOME = root;
  process.env.ZCODE_STORAGE_DIR = root;
  process.env.ZCODE_SESSION_DB_PATH = join(root, "cli", "db", "db.sqlite");
  delete process.env.ZCODE_SESSION_DB;
  if (existsSync(join(root, "v2", "tasks-index.sqlite"))) {
    process.env.CCODE_LEGACY_SESSION_DB = join(homedir(), ".zcode", "cli", "db", "db.sqlite");
  } else {
    delete process.env.CCODE_LEGACY_SESSION_DB;
  }
}
