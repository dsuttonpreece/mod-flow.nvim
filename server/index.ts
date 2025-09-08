import { attach } from "neovim";

async function main() {
  const nvim = attach({
    reader: process.stdin,
    writer: process.stdout,
  });

  nvim.logger.info("Node.js server started and connected to Neovim");

  nvim.on("notification", (method, args) => {
    nvim.logger.info(
      `Received notification: ${method} with args: ${JSON.stringify(args)}`,
    );
    const [requestId, requestArgs] = args;

    if (method === "hello_world") {
      // Simulate slow work with setTimeout
      setTimeout(() => {
        const result = "Hello from Node.js server!";
        nvim.logger.info(`Sending response: ${requestId}, ${result}`);
        nvim.call("luaeval", [
          `require('mod-flow').handle_response(${requestId}, '${result}')`,
          {},
        ]);
      }, 1000); // 1 second delay to test non-blocking behavior
    }
  });
}

main().catch((err) => {
  console.error(err);
});
