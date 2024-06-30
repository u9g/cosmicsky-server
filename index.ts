import pg from "pg";
const { Client } = pg;
const client = new Client({
  connectionString:
    "postgresql://teamsdb_user:AEk2Pn5l0Va80MOwZDkiMbM7Y6IaRR2P@dpg-cpve4ihu0jms73aqpd40-a/teamsdb",
});
await client.connect();

// await client.query("DROP TABLE teams");
// await client.query("DROP TABLE team_members");
// await client.query("DROP TABLE team_invites");

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
);`);

await client.query(`CREATE TABLE IF NOT EXISTS team_invites (
	player_invited_uuid
		TEXT
		NOT NULL,
	team_invited_id
		TEXT
		NOT NULL
);`);

await client.query(`CREATE TABLE IF NOT EXISTS player_settings (
	player_uuid
		TEXT
		NOT NULL,
	show_pings
		BOOLEAN
);`);
await client.query(`DO $$
BEGIN
    -- Check if the column does not exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='player_settings' AND column_name='pings_sent_to_chat') THEN
        -- Add the column if it does not exist
        ALTER TABLE player_settings ADD COLUMN pings_sent_to_chat BOOLEAN;
    END IF;
END $$;`);

const res = await client.query("SELECT $1::text as message", ["Hello world!"]);
console.log(res.rows[0].message); // Hello world!
// await client.end();

async function uuidFromUsername(username: string): Promise<string> {
  const response = (await (
    await fetch(`https://api.ashcon.app/mojang/v2/user/${username}`)
  ).json()) as any;

  return response.uuid;
}

async function usernameFromUUID(uuid: string): Promise<string> {
  const response = (await (
    await fetch(`https://api.ashcon.app/mojang/v2/user/${uuid}`)
  ).json()) as any;

  return response.username;
}

Bun.serve<{ username: string; uuid: string }>({
  websocket: {
    publishToSelf: true,
    async message(ws, message) {
      if (typeof message !== "string") return;
      if (!ws.data) return;
      try {
        const packet:
          | { type: "connected"; username: string; uuid: string }
          | { type: "disconnected" }
          | { type: "ping"; x: number; y: number; z: number }
          | { type: "createTeam"; teamName: string }
          | { type: "joinTeam"; teamName: string }
          | { type: "listTeamMembers" }
          | { type: "leaveTeam" }
          | { type: "kickFromTeam"; playerName: string }
          | { type: "disbandTeam" }
          | { type: "showSettings" }
          | { type: "invitetoteam"; playerInvited: string } =
          JSON.parse(message);

        console.log(`received packet: ${JSON.stringify(packet)}`);

        switch (packet.type) {
          case "connected": {
            const { username, uuid } = packet;
            ws.data = { username, uuid };
            ws.subscribe(uuid); // for notifications

            const teamIds = await client.query(
              `SELECT team_id FROM team_members WHERE player_uuid = $1;`,
              [ws.data.uuid]
            );

            if (teamIds.rows.length > 0) {
              ws.subscribe(teamIds.rows[0].team_id);
            }

            const settings = await client.query(
              `SELECT show_pings FROM player_settings WHERE player_uuid = $1;`,
              [ws.data.uuid]
            );

            if (settings.rows.length > 0) {
              const s = settings.rows[0];

              if (s.show_pings) {
                ws.publish(
                  ws.data.uuid,
                  JSON.stringify({
                    type: "setting",
                    name: "show_pings",
                    value: s.show_pings,
                  })
                );
              }
            }
            break;
          }
          case "showSettings": {
            const settings = await client.query(
              `SELECT show_pings FROM player_settings WHERE player_uuid = $1;`,
              [ws.data.uuid]
            );

            const defaults = { show_pings: true, pings_sent_to_chat: false };

            const playerSettings =
              settings.rows.length > 0 ? settings.rows[0] : defaults;

            let showPings = playerSettings.show_pings ?? defaults.show_pings;
            let pingsSentToChat =
              playerSettings.pings_sent_to_chat ?? defaults.pings_sent_to_chat;

            let lines = [
              "<#9b5de5><bold><u>Settings</u> <gray>(Click on setting to change)</gray>",
              `<#00bbf9>Pings <#00f5d4>=> ${
                showPings ? "<#f15bb5>Enabled" : "<#fee440>Disabled"
              }`,
              `<#00bbf9>Pings sent to chat <#00f5d4>=> ${
                pingsSentToChat ? "<#f15bb5>Enabled" : "<#fee440>Disabled"
              }`,
            ];
            ws.publish(
              ws.data.uuid,
              JSON.stringify({
                type: "notification",
                minimessage: "\n\n" + lines.join("\n\n") + "\n\n",
              })
            );
            break;
          }
          case "disconnected": {
            // ws.unsubscribe();
            break;
          }
          case "joinTeam": {
            {
              const teamIds = await client.query(
                `SELECT team_id FROM team_members WHERE player_uuid = $1;`,
                [ws.data.uuid]
              );
              if (teamIds.rows.length > 0) {
                ws.publish(
                  ws.data.uuid,
                  JSON.stringify({
                    type: "notification",
                    message: `You are already in the team: '${teamIds.rows[0].team_id}', run /leaveteam to leave your team before joining a new team.`,
                  })
                );
                break;
              }
            }

            // team_invites player_invited_uuid team_invited_id
            const teamIds = await client.query(
              `
              SELECT team_invited_id from team_invites WHERE team_invited_id = $1 AND player_invited_uuid = $2;`,
              [packet.teamName, ws.data.uuid]
            );
            if (teamIds.rows.length > 0) {
              const teamName = teamIds.rows[0].team_invited_id;

              await client.query(
                `INSERT INTO team_members (player_uuid, team_id) VALUES ($1, $2);`,
                [ws.data.uuid, teamName]
              );

              await client.query(
                `DELETE FROM team_invites WHERE team_invited_id = $1 AND player_invited_uuid = $2;`,
                [packet.teamName, ws.data.uuid]
              );

              ws.publish(
                ws.data.uuid,
                JSON.stringify({
                  type: "notification",
                  message: `You joined the team '${teamName}'.`,
                })
              );
            } else {
              ws.publish(
                ws.data.uuid,
                JSON.stringify({
                  type: "notification",
                  message: "Failed to join team, you have no pending invite.",
                })
              );
            }
            break;
          }
          case "leaveTeam": {
            // todo: if you are the last member you should only be able to disband your team.
            const result = await client.query(
              `DELETE FROM team_members WHERE player_uuid = $1;`,
              [ws.data.uuid]
            );
            ws.publish(
              ws.data.uuid,
              JSON.stringify({
                type: "notification",
                message: `Left team (${result.rowCount})`,
              })
            );
            break;
          }
          case "disbandTeam": {
            const { uuid } = ws.data;
            const teamIds = await client.query(
              `SELECT team_id FROM teams WHERE owner_uuid = $1;`,
              [uuid]
            );
            if (teamIds.rows.length > 0) {
              const { rowCount: teamMembersCount } = await client.query(
                `DELETE FROM team_members WHERE team_id = $1`,
                [teamIds.rows[0].team_id]
              );
              const { rowCount: teamCount } = await client.query(
                `DELETE FROM teams WHERE team_id = $1`,
                [teamIds.rows[0].team_id]
              );
              const { rowCount: inviteCount } = await client.query(
                `DELETE FROM team_invites WHERE team_invited_id = $1`,
                [teamIds.rows[0].team_id]
              );
              ws.publish(
                uuid,
                JSON.stringify({
                  type: "notification",
                  message: `Disbanded team (${teamCount}), kicked members (${teamMembersCount}), revoked invites (${inviteCount}).`,
                })
              );
              // todo: unsubscribe them and members of that team from pings to that name
              // otherwise if someone remakes that team with same name they will get those pings...
            } else {
              ws.publish(
                uuid,
                JSON.stringify({
                  type: "notification",
                  message: `You don't own a team.`,
                })
              );
            }
            break;
          }
          case "kickFromTeam": {
            const { uuid } = ws.data;
            const teamIds = await client.query(
              `SELECT team_id FROM teams WHERE owner_uuid = $1;`,
              [uuid]
            );
            if (teamIds.rows.length > 0) {
              const result = await client.query(
                `DELETE FROM team_members WHERE team_id = $1 AND player_uuid = $2;`,
                [
                  teamIds.rows[0].team_id,
                  await uuidFromUsername(packet.playerName),
                ]
              );
              ws.publish(
                uuid,
                JSON.stringify({
                  type: "notification",
                  message: `Tried to kick player from team. (${result.rowCount})`,
                })
              );
            } else {
              ws.publish(
                uuid,
                JSON.stringify({
                  type: "notification",
                  message: `You don't own a team.`,
                })
              );
            }
            break;
          }
          case "listTeamMembers": {
            const teamIds = await client.query(
              `SELECT team_id FROM team_members WHERE player_uuid = $1;`,
              [ws.data.uuid]
            );
            const { uuid } = ws.data;
            if (teamIds.rows.length > 0) {
              const { team_id } = teamIds.rows[0];
              const playerUUIDs = await client.query(
                `SELECT player_uuid FROM team_members WHERE team_id = $1;`,
                [team_id]
              );
              const playersInTeam = await Promise.all(
                playerUUIDs.rows.map((x) => usernameFromUUID(x.player_uuid))
              );

              ws.publish(
                uuid,
                JSON.stringify({
                  type: "notification",
                  message: `Players in '${team_id}': ${playersInTeam.join(
                    ", "
                  )}`,
                })
              );
            } else {
              ws.publish(
                uuid,
                JSON.stringify({
                  type: "notification",
                  message:
                    "Tou don't have a team! Join a team first before listing team members.",
                })
              );
            }
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
                break;
              }
            }

            {
              const teamIds = await client.query(
                `SELECT team_id FROM teams WHERE owner_uuid = $1;`,
                [ws.data.uuid]
              );

              if (teamIds.rows.length > 0) {
                ws.publish(
                  ws.data.uuid,
                  JSON.stringify({
                    type: "notification",
                    message: "Failed to create team, you already have a team!",
                  })
                );
                break;
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
                break;
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

              if (teamIds.rows.length === 0) {
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
          case "invitetoteam": {
            const teamIds = await client.query(
              `SELECT team_id FROM teams WHERE owner_uuid = $1;`,
              [ws.data.uuid]
            );

            const uuidInvited = await uuidFromUsername(packet.playerInvited);
            if (teamIds.rows.length === 0) {
              ws.publish(
                ws.data.uuid,
                JSON.stringify({
                  type: "notification",
                  message: "Failed to invite to team, you don't own a team.",
                })
              );
            } else {
              const teamId = teamIds.rows[0].team_id;
              await client.query(
                `INSERT INTO team_invites (player_invited_uuid, team_invited_id) VALUES ($1, $2);`,
                [uuidInvited, teamId]
              );
              ws.publish(
                ws.data.uuid,
                JSON.stringify({
                  type: "notification",
                  message: `You have invited '${packet.playerInvited}' to team: '${teamId}'. To join, tell them to run /jointeam ${teamId}`,
                })
              );
              ws.publish(
                uuidInvited,
                JSON.stringify({
                  type: "notification",
                  message: `You have been invited to team: '${teamId}'. To join run /jointeam ${teamId}`,
                })
              );
            }

            break;
          }
          case "ping": {
            console.log(`data: ${JSON.stringify(ws.data)}`);

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
