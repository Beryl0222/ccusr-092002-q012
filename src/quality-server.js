import { pathToFileURL } from "node:url";
import { createQualityServer, healthPayload, qualityServiceId } from "./quality/http.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--check")) {
    if (healthPayload().service !== qualityServiceId) process.exit(1);
    console.log("质量服务基础检查通过");
  } else {
    const portIndex = process.argv.indexOf("--port");
    const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 8001;
    createQualityServer().listen(port, "0.0.0.0");
    console.log(`${qualityServiceId} 监听 :${port}`);
  }
}
