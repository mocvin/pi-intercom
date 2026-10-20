import { registerWakeProvider } from "./provider.ts";
import { SESSIOND_PROVIDER_ID, createSessiondProvider } from "./sessiond.ts";

registerWakeProvider(SESSIOND_PROVIDER_ID, (options) => createSessiondProvider(options));
