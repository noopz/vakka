type LogLevel = "info" | "warn" | "error" | "debug";

function formatTimestamp(): string {
  return new Date().toISOString();
}

function log(level: LogLevel, component: string, message: string, data?: unknown): void {
  const timestamp = formatTimestamp();
  const prefix = `[${timestamp}] [${level.toUpperCase()}] [${component}]`;

  if (data !== undefined) {
    console.log(`${prefix} ${message}`, typeof data === "object" ? JSON.stringify(data) : data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

export const logger = {
  info: (component: string, message: string, data?: unknown) => log("info", component, message, data),
  warn: (component: string, message: string, data?: unknown) => log("warn", component, message, data),
  error: (component: string, message: string, data?: unknown) => log("error", component, message, data),
  debug: (component: string, message: string, data?: unknown) => log("debug", component, message, data),
};
