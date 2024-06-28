import pg from "pg";
const { Client } = pg;
const client = new Client({
  connectionString:
    "postgresql://teamsdb_user:AEk2Pn5l0Va80MOwZDkiMbM7Y6IaRR2P@dpg-cpve4ihu0jms73aqpd40-a/teamsdb",
});
await client.connect();

await client.query(`CREATE TABLE IF NOT EXISTS teams (
	team_id
		TEXT
		NOT NULL
		PRIMARY KEY,
	owner_uuid
		TEXT
		NOT NULL
		UNIQUE
);`);

await client.query(`CREATE TABLE IF NOT EXISTS team_members (
	player_uuid
		TEXT
		NOT NULL
		PRIMARY KEY,
	team_id
		TEXT
		NOT NULL
		UNIQUE
);`);

const res = await client.query("SELECT $1::text as message", ["Hello world!"]);
console.log(res.rows[0].message); // Hello world!
// await client.end();

async function uuidFromUsername(username: string): Promise<string> {
  const response = (await (
    await fetch(`https://api.ashcon.app/mojang/v2/user/${username}`)
  ).json()) as any;

  return response.uuid;
}

Bun.serve<{ username: string; host: string; uuid: string }>({
  websocket: {
    publishToSelf: true,
    async message(ws, message) {
      if (typeof message !== "string") return;
      try {
        const packet:
          | { type: "connected"; username: string; host: string; uuid: string }
          | { type: "disconnected" }
          | { type: "ping"; x: number; y: number; z: number }
          | { type: "createTeam"; teamName: string } = JSON.parse(message);

        console.log(`received packet: ${JSON.stringify(packet)}`);
        if (
          packet.type === "connected" &&
          packet.host.includes("midnightsky.") === true
        ) {
          packet.host = "midnightsky";
        }

        switch (packet.type) {
          case "connected": {
            const { username, host, uuid } = packet;
            ws.data = { host, username, uuid };
            ws.subscribe(uuid); // for notifications

            const teamIds = await client.query(
              `SELECT team_id FROM team_members WHERE player_uuid = $1;`,
              [ws.data.uuid]
            );

            if (teamIds.rows.length > 0) {
              ws.subscribe(teamIds.rows[0].team_id);
            }
            break;
          }
          case "disconnected": {
            ws.unsubscribe(ws.data.host);
            break;
          }
          case "createTeam": {
            const { uuid } = ws.data;

            {
              const teamIds = await client.query(
                `SELECT owner_uuid FROM teams WHERE team_id = $1;`,
                [packet.teamName]
              );

              if (teamIds.rows.length > 0) {
                ws.publish(
                  ws.data.uuid,
                  JSON.stringify({
                    type: "notification",
                    message:
                      "Failed to create team, a team with this name already exists.",
                  })
                );
              }
            }

            {
              const teamIds = await client.query(
                `SELECT team_id FROM team_members WHERE player_uuid = $1;`,
                [uuid]
              );

              if (teamIds.rows.length > 0) {
                ws.publish(
                  ws.data.uuid,
                  JSON.stringify({
                    type: "notification",
                    message: "Failed to create team, you already have a team.",
                  })
                );
              }
            }

            await client.query(
              `INSERT INTO teams (team_id, owner_uuid) VALUES ($1, $2);`,
              [packet.teamName, ws.data.uuid]
            );
            await client.query(
              `INSERT INTO team_members (player_uuid, team_id) VALUES ($1, $2);`,
              [ws.data.uuid, packet.teamName]
            );

            {
              const teamIds = await client.query(
                `SELECT team_id FROM team_members WHERE player_uuid = $1;`,
                [uuid]
              );

              if (teamIds.rows.length > 0) {
                ws.publish(
                  ws.data.uuid,
                  JSON.stringify({
                    type: "notification",
                    message:
                      "Failed to create team, contact @U9G on discord, code 12.",
                  })
                );
              } else {
                ws.publish(
                  ws.data.uuid,
                  JSON.stringify({
                    type: "notification",
                    message: `Created team with name '${packet.teamName}'`,
                  })
                );
                ws.subscribe(teamIds.rows[0].team_id);
              }
            }

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

            const teamIds = await client.query(
              `SELECT team_id FROM team_members WHERE player_uuid = $1;`,
              [ws.data.uuid]
            );
            const { username, uuid } = ws.data;
            if (teamIds.rows.length > 0) {
              const { team_id } = teamIds.rows[0];
              const { x, y, z } = packet;
              ws.publish(
                team_id,
                JSON.stringify({ x, y, z, username, type: "ping" })
              );
              console.log(`${username} pinged (${x}, ${y}, ${z})`);
            } else {
              ws.publish(
                uuid,
                JSON.stringify({
                  type: "notification",
                  message:
                    "Failed to ping, you don't have a team! Join a team first before pinging.",
                })
              );
            }

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
