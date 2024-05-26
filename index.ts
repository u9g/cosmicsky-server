Bun.serve<{ username: string; host: string }>({
  websocket: {
    publishToSelf: true,
    message(ws, message) {
      if (typeof message !== "string") return;
      try {
        const packet:
          | { type: "connected"; username: string; host: string }
          | { type: "disconnected" }
          | { type: "ping"; x: number; y: number; z: number } =
          JSON.parse(message);

        console.log(`received packet: ${JSON.stringify(packet)}`);
        if (
          packet.type === "connected" &&
          packet.host.includes("midnightsky.") === true
        ) {
          packet.host = "midnightsky";
        }

        switch (packet.type) {
          case "connected": {
            const { username, host } = packet;
            ws.data = { host, username };
            ws.subscribe(ws.data.host);
            break;
          }
          case "disconnected": {
            ws.unsubscribe(ws.data.host);
            break;
          }
          case "ping": {
            console.log(`data: ${JSON.stringify(ws.data)}`);
            if (ws.data.host === "") {
              console.log(
                `ip is an empty string, so returning early, packet: ${JSON.stringify(
                  packet
                )}`
              );
              break;
            }
            const { x, y, z } = packet;
            const { username, host } = ws.data;

            console.log(`${username} pinged (${x}, ${y}, ${z})`);

            ws.publish(host, JSON.stringify({ x, y, z, username }));

            break;
          }
          default: {
            console.log(
              `Unexpected packet of type: ${
                (packet as any).type
              }, packet: ${JSON.stringify(packet)}`
            );
            break;
          }
        }
      } catch (e) {
        console.log(e);
        return;
      }
    },
  },
  fetch(request, server) {
    const upgraded = server.upgrade(request);
    if (!upgraded) {
      return new Response("Upgrade failed", { status: 400 });
    }
  },
});
