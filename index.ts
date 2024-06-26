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
// await client.query("DROP TABLE player_settings");

const settings = [
  {
    id: "show_pings",
    default: true,
    type: "boolean",
    description: "Show Pings ingame",
  },
  {
    id: "pings_sent_to_chat",
    default: false,
    type: "boolean",
    description: "Show Pings in chat",
  },
  {
    id: "disable_swinging_at_low_durability",
    default: true,
    type: "boolean",
    description: "Disable swinging at low durability",
  },
  {
    id: "should_ping_make_sounds",
    default: true,
    type: "boolean",
    description: "Pings make sounds",
  },
  {
    id: "should_show_death_pings",
    default: true,
    type: "boolean",
    description: "Show death pings",
  },
  {
    id: "replace_fix_to_fix_all",
    default: true,
    type: "boolean",
    description: "Redirect /fix to /fix all",
  },
] as const satisfies {
  id: string;
  default: boolean;
  type: "boolean";
  description: string;
}[];

// team_id should be UNIQUE
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
    UNIQUE
		NOT NULL,
	show_pings
		BOOLEAN
);`);

for (let i = 1; i < settings.length; i++) {
  if (settings[i].type === "boolean") {
    await client.query(`DO $$
  BEGIN
      -- Check if the column does not exist
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='player_settings' AND column_name='${settings[i].id}') THEN
          -- Add the column if it does not exist
          ALTER TABLE player_settings ADD COLUMN ${settings[i].id} BOOLEAN;
      END IF;
  END $$;`);
  }
}

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

      async function sendSettingsToClient() {
        const settingsFromDB = await client.query(
          `SELECT ${settings
            .map((x) => x.id)
            .join(", ")} FROM player_settings WHERE player_uuid = $1;`,
          [ws.data.uuid]
        );

        if (settingsFromDB.rows.length > 0) {
          const s = settingsFromDB.rows[0];

          const keys = Object.keys(s);

          for (const setting of settings) {
            if (keys.includes(setting.id)) {
              ws.publish(
                ws.data.uuid,
                JSON.stringify({
                  type: "setting",
                  name: setting.id,
                  value: s[setting.id],
                })
              );
            }
          }
        }
      }

      try {
        const packet:
          | {
              type: "connected";
              username: string;
              uuid: string;
              version?: string;
            }
          | { type: "disconnected" }
          | { type: "ping"; x: number; y: number; z: number; pingType?: string }
          | { type: "createTeam"; teamName: string }
          | { type: "joinTeam"; teamName: string }
          | { type: "listTeamMembers" }
          | { type: "leaveTeam" }
          | { type: "kickFromTeam"; playerName: string }
          | { type: "disbandTeam" }
          | { type: "showSettings" }
          | { type: "settingsCmd"; cmd: string }
          | { type: "invitetoteam"; playerInvited: string } =
          JSON.parse(message);

        console.log(`received packet: ${JSON.stringify(packet)}`);

        if (packet.type !== "connected" && !ws.data) return;
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
              ws.publish(
                ws.data.uuid,
                JSON.stringify({
                  type: "setting",
                  name: "enable_mod",
                  value: true,
                })
              );
            }

            await sendSettingsToClient();

            if (packet.version !== "1.1.1") {
              // todo: send message to update mod
              ws.publish(
                ws.data.uuid,
                JSON.stringify({
                  type: "notification",
                  message:
                    "\n\nUpdate to latest version of the mod for a ton of new features in #mods in NF disc.\n\n",
                })
              );
            }
            break;
          }
          case "showSettings": {
            const settingsFromDB = await client.query(
              `SELECT ${settings
                .map((x) => x.id)
                .join(", ")} FROM player_settings WHERE player_uuid = $1;`,
              [ws.data.uuid]
            );

            const defaults: Record<string, any> = {};
            for (const setting of settings) {
              defaults[setting.id] = setting.default;
            }

            const playerSettings =
              settingsFromDB.rows.length > 0
                ? settingsFromDB.rows[0]
                : defaults;

            const enable = "<#fee440>Enable";
            const disable = "<#f15bb5>Disable";

            let lines = [
              "<#9b5de5><bold><u>Settings</u> <gray>(Click on setting to change)</gray>",
            ];

            for (const setting of settings) {
              let settingCurrentValue =
                playerSettings[setting.id] ?? defaults[setting.id];

              lines.push(
                `<#00bbf9>${
                  setting.description
                } <#00f5d4>=> <hover:show_text:'<white>Click to ${
                  !settingCurrentValue ? enable : disable
                }'><click:run_command:/skyplussettings ${setting.id} ${
                  !settingCurrentValue ? "enable" : "disable"
                }>${settingCurrentValue ? enable : disable}d</hover>`
              );
            }

            const json = await (
              await fetch("https://webui.advntr.dev/api/mini-to-json", {
                headers: {
                  accept: "*/*",
                  "accept-language": "en-US,en;q=0.9",
                  "cache-control": "max-age=0",
                  "content-type": "text/plain; charset=UTF-8",
                  priority: "u=1, i",
                  "sec-ch-ua":
                    '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
                  "sec-ch-ua-mobile": "?0",
                  "sec-ch-ua-platform": '"Windows"',
                  "sec-fetch-dest": "empty",
                  "sec-fetch-mode": "cors",
                  "sec-fetch-site": "same-origin",
                },
                referrer: "https://webui.advntr.dev/",
                referrerPolicy: "strict-origin-when-cross-origin",
                body: JSON.stringify({
                  miniMessage: "\n\n" + lines.join("\n\n") + "\n\n",
                  placeholders: { stringPlaceholders: {} },
                }),
                method: "POST",
                mode: "cors",
                credentials: "omit",
              })
            ).text();

            ws.publish(
              ws.data.uuid,
              JSON.stringify({
                type: "notification",
                json,
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

            // Looks for teams which have the team name you wanted
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
              const { x, y, z, pingType } = packet;
              let pingTypeToSend = pingType ?? "manual";
              ws.publish(
                team_id,
                JSON.stringify({
                  x,
                  y,
                  z,
                  username,
                  type: "ping",
                  pingType: pingTypeToSend,
                })
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
          case "settingsCmd": {
            const commandData = packet.cmd.split(" ");

            const updateQuery = (fieldName: string) =>
              `INSERT INTO player_settings (player_uuid, ${fieldName}) VALUES ($1, $2) ON CONFLICT (player_uuid) DO UPDATE SET ${fieldName} = excluded.${fieldName};`;
            async function booleanHandler(fieldName: string) {
              if (commandData[1] === "enable") {
                await client.query(updateQuery(fieldName), [
                  ws.data.uuid,
                  true,
                ]);
                ws.publish(
                  ws.data.uuid,
                  JSON.stringify({
                    type: "notification",
                    message: `Updated ${fieldName} to true.`,
                  })
                );
              } else if (commandData[1] === "disable") {
                await client.query(updateQuery(fieldName), [
                  ws.data.uuid,
                  false,
                ]);
                ws.publish(
                  ws.data.uuid,
                  JSON.stringify({
                    type: "notification",
                    message: `Updated ${fieldName} to false.`,
                  })
                );
              } else {
                ws.publish(
                  ws.data.uuid,
                  JSON.stringify({
                    type: "notification",
                    message: `Unexpected argument value (${commandData[1]}) for setting '${fieldName}', expected true or false.`,
                  })
                );
              }
            }

            if (commandData.length === 2) {
              for (const setting of settings) {
                if (setting.type === "boolean") {
                  if (commandData[0] === setting.id) {
                    await booleanHandler(setting.id);
                  }
                }
              }
            }

            await sendSettingsToClient();
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
