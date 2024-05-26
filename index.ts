Bun.serve<{ username: string; ip: string }>({
  websocket: {
    publishToSelf: true,
    message(ws, message) {
      if (typeof message !== "string") return;
      try {
        const packet = JSON.parse(message);
        console.log(`received packet: ${JSON.stringify(packet)}`);
        if (packet?.ip?.includes("midnightsky.") === true) {
          packet.ip = "midnightsky";
        }

        switch (packet.type) {
          case "connected":
            ws.data = { ip: packet.ip, username: packet.username };
            ws.subscribe(packet.ip);
            break;
          case "disconnected":
            ws.unsubscribe(ws.data.ip);
            ws.data.ip = "";
            break;
          case "ping":
            if (ws.data.ip === "") {
              console.log(
                `ip is an empty string, so returning early, packet: ${JSON.stringify(
                  packet
                )}`
              );
              break;
            }
            const { x, y, z } = packet;
            const { username } = ws.data;

            console.log(`${username} pinged (${x}, ${y}, ${z})`);

            ws.publish(ws.data.ip, JSON.stringify({ x, y, z, username }));

            break;
          default:
            console.log(
              `Unexpected packet of type: ${
                packet.type
              }, packet: ${JSON.stringify(packet)}`
            );
            break;
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
