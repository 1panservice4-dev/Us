const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;

const rooms = new Map();

const COLORS = [
    "#e53935",
    "#1e88e5",
    "#43a047",
    "#fdd835",
    "#8e24aa",
    "#fb8c00",
    "#00acc1",
    "#6d4c41",
    "#d81b60",
    "#546e7a"
];

function makeRoomCode() {
    let code;

    do {
        code = Math.floor(100000 + Math.random() * 900000).toString();
    } while (rooms.has(code));

    return code;
}

function send(ws, type, data = {}) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    ws.send(JSON.stringify({
        type,
        ...data
    }));
}

function broadcast(room, type, data = {}) {
    for (const player of room.players.values()) {
        send(player.ws, type, data);
    }
}

function broadcastExcept(room, exceptId, type, data = {}) {
    for (const player of room.players.values()) {
        if (player.id !== exceptId) {
            send(player.ws, type, data);
        }
    }
}

function publicPlayer(player) {
    return {
        id: player.id,
        name: player.name,
        color: player.color,
        x: player.x,
        y: player.y,
        alive: player.alive,
        role: null
    };
}

function lobbyPlayers(room) {
    return [...room.players.values()].map(publicPlayer);
}

function gamePlayers(room) {
    return [...room.players.values()].map(player => ({
        ...publicPlayer(player),
        role: player.role,
        alive: player.alive
    }));
}

function createRoom(host) {
    const code = makeRoomCode();

    const room = {
        code,
        hostId: host.id,
        started: false,

        settings: {
            impostors: 1,
            killCooldown: 25,
            meetingTime: 30
        },

        players: new Map(),

        bodies: [],

        meeting: null,

        tasksTotal: 0,
        tasksDone: 0,

        winner: null
    };

    rooms.set(code, room);

    return room;
}

function getAlivePlayers(room) {
    return [...room.players.values()].filter(p => p.alive);
}

function getAliveCrew(room) {
    return [...room.players.values()]
        .filter(p => p.alive && p.role === "crew");
}

function getAliveImpostors(room) {
    return [...room.players.values()]
        .filter(p => p.alive && p.role === "impostor");
}

function checkWin(room) {
    if (!room.started || room.winner) return;

    const impostors = getAliveImpostors(room);
    const crew = getAliveCrew(room);

    if (impostors.length === 0) {
        endGame(room, "crew");
        return;
    }

    if (impostors.length >= crew.length) {
        endGame(room, "impostor");
        return;
    }

    if (room.tasksTotal > 0 && room.tasksDone >= room.tasksTotal) {
        endGame(room, "crew");
    }
}

function endGame(room, winner) {
    if (room.winner) return;

    room.winner = winner;
    room.started = false;

    broadcast(room, "game_over", {
        winner,
        players: gamePlayers(room)
    });
}

function assignRoles(room) {
    const players = [...room.players.values()];

    const count = Math.min(
        room.settings.impostors,
        Math.max(1, Math.floor(players.length / 3))
    );

    players.forEach(p => {
        p.role = "crew";
        p.alive = true;
        p.killCooldown = 0;
        p.tasks = [];
        p.completedTasks = 0;
    });

    const shuffled = [...players];

    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    for (let i = 0; i < count; i++) {
        shuffled[i].role = "impostor";
    }

    room.tasksTotal = 0;
    room.tasksDone = 0;

    for (const player of players) {
        if (player.role === "crew") {
            player.tasks = [false, false, false];
            room.tasksTotal += 3;
        }
    }
}

function startGame(room) {
    if (room.started) return;

    if (room.players.size < 2) {
        send(room.players.get(room.hostId)?.ws, "error", {
            message: "게임을 시작하려면 최소 2명이 필요합니다."
        });
        return;
    }

    assignRoles(room);

    room.started = true;
    room.winner = null;
    room.bodies = [];
    room.meeting = null;

    for (const player of room.players.values()) {
        player.x = 500 + Math.random() * 300;
        player.y = 350 + Math.random() * 150;

        send(player.ws, "game_started", {
            self: {
                id: player.id,
                role: player.role,
                color: player.color
            },
            players: gamePlayers(room),
            settings: room.settings
        });
    }
}

function updatePositions(room) {
    const data = [...room.players.values()].map(p => ({
        id: p.id,
        x: p.x,
        y: p.y,
        alive: p.alive
    }));

    broadcast(room, "positions", {
        players: data
    });
}

function startMeeting(room, reporterId) {
    if (room.meeting) return;

    const reporter = room.players.get(reporterId);

    room.meeting = {
        votes: new Map(),
        time: room.settings.meetingTime,
        reporterId
    };

    broadcast(room, "meeting_started", {
        reporter: reporter
            ? reporter.name
            : "긴급회의",
        bodies: room.bodies.map(b => ({
            id: b.id,
            name: b.name
        })),
        players: gamePlayers(room),
        time: room.meeting.time
    });

    room.bodies = [];

    setTimeout(() => {
        if (room.meeting) {
            finishMeeting(room);
        }
    }, room.settings.meetingTime * 1000);
}

function finishMeeting(room) {
    if (!room.meeting) return;

    const counts = {};

    for (const vote of room.meeting.votes.values()) {
        counts[vote] = (counts[vote] || 0) + 1;
    }

    let target = "skip";
    let highest = 0;
    let tie = false;

    for (const [id, count] of Object.entries(counts)) {
        if (id === "skip") continue;

        if (count > highest) {
            highest = count;
            target = id;
            tie = false;
        } else if (count === highest) {
            tie = true;
        }
    }

    if (tie || highest === 0) {
        target = "skip";
    }

    let ejected = null;

    if (target !== "skip") {
        const player = room.players.get(target);

        if (player && player.alive) {
            player.alive = false;
            ejected = {
                id: player.id,
                name: player.name,
                role: player.role
            };
        }
    }

    room.meeting = null;

    broadcast(room, "meeting_result", {
        ejected
    });

    checkWin(room);
}

function handleMessage(ws, msg) {
    const player = ws.player;

    if (!player) return;

    const room = rooms.get(player.roomCode);

    if (!room) return;

    switch (msg.type) {

        case "chat": {
            const text = String(msg.text || "").slice(0, 200);

            if (!text) return;

            broadcast(room, "chat", {
                player: player.name,
                color: player.color,
                text
            });

            break;
        }

        case "move": {
            if (!room.started) return;

            if (!player.alive) return;

            const x = Number(msg.x);
            const y = Number(msg.y);

            if (!Number.isFinite(x) || !Number.isFinite(y)) {
                return;
            }

            player.x = Math.max(40, Math.min(960, x));
            player.y = Math.max(40, Math.min(650, y));

            updatePositions(room);

            break;
        }

        case "kill": {
            if (!room.started) return;
            if (player.role !== "impostor") return;
            if (!player.alive) return;
            if (player.killCooldown > Date.now()) return;

            const target = room.players.get(msg.targetId);

            if (!target) return;
            if (!target.alive) return;
            if (target.role === "impostor") return;

            const dx = player.x - target.x;
            const dy = player.y - target.y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance > 80) return;

            target.alive = false;

            room.bodies.push({
                id: target.id,
                name: target.name,
                x: target.x,
                y: target.y
            });

            player.killCooldown =
                Date.now() + room.settings.killCooldown * 1000;

            broadcast(room, "player_killed", {
                killerId: player.id,
                targetId: target.id,
                body: {
                    id: target.id,
                    name: target.name,
                    x: target.x,
                    y: target.y
                }
            });

            checkWin(room);

            break;
        }

        case "report": {
            if (!room.started) return;
            if (!player.alive) return;

            const body = room.bodies.find(b => {
                const dx = player.x - b.x;
                const dy = player.y - b.y;

                return Math.sqrt(dx * dx + dy * dy) < 90;
            });

            if (!body) return;

            startMeeting(room, player.id);

            break;
        }

        case "emergency": {
            if (!room.started) return;
            if (!player.alive) return;

            startMeeting(room, player.id);

            break;
        }

        case "vote": {
            if (!room.meeting) return;
            if (!player.alive) return;

            const target = String(msg.target || "skip");

            if (
                target !== "skip" &&
                !room.players.has(target)
            ) {
                return;
            }

            room.meeting.votes.set(player.id, target);

            send(player.ws, "vote_registered", {
                target
            });

            const aliveCount = getAlivePlayers(room).length;

            if (room.meeting.votes.size >= aliveCount) {
                finishMeeting(room);
            }

            break;
        }

        case "task": {
            if (!room.started) return;
            if (!player.alive) return;
            if (player.role !== "crew") return;

            const index = Number(msg.index);

            if (
                !Number.isInteger(index) ||
                index < 0 ||
                index >= player.tasks.length
            ) {
                return;
            }

            if (player.tasks[index]) return;

            player.tasks[index] = true;
            player.completedTasks++;

            room.tasksDone++;

            send(player.ws, "task_done", {
                index,
                completed: player.completedTasks,
                total: player.tasks.length
            });

            broadcast(room, "task_progress", {
                done: room.tasksDone,
                total: room.tasksTotal
            });

            checkWin(room);

            break;
        }

        case "settings": {
            if (player.id !== room.hostId) return;
            if (room.started) return;

            if (Number.isInteger(msg.impostors)) {
                room.settings.impostors =
                    Math.max(1, Math.min(3, msg.impostors));
            }

            if (Number.isInteger(msg.killCooldown)) {
                room.settings.killCooldown =
                    Math.max(5, Math.min(60, msg.killCooldown));
            }

            if (Number.isInteger(msg.meetingTime)) {
                room.settings.meetingTime =
                    Math.max(15, Math.min(90, msg.meetingTime));
            }

            broadcast(room, "settings", {
                settings: room.settings
            });

            break;
        }

        case "start": {
            if (player.id !== room.hostId) return;

            startGame(room);

            break;
        }
    }
}

wss.on("connection", ws => {

    const id =
        Date.now().toString(36) +
        Math.random().toString(36).slice(2);

    ws.on("message", raw => {

        let msg;

        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return;
        }

        if (!msg || typeof msg.type !== "string") {
            return;
        }

        // 방 생성
        if (msg.type === "create") {

            if (ws.player) return;

            const name =
                String(msg.name || "플레이어")
                    .slice(0, 16);

            const player = {
                id,
                ws,
                roomCode: null,
                name,
                color: COLORS[0],
                x: 500,
                y: 400,
                role: null,
                alive: true,
                tasks: [],
                completedTasks: 0,
                killCooldown: 0
            };

            const room = createRoom(player);

            player.roomCode = room.code;

            room.players.set(player.id, player);

            ws.player = player;

            send(ws, "room_created", {
                code: room.code,
                playerId: player.id,
                host: true,
                color: player.color,
                settings: room.settings
            });

            send(ws, "lobby", {
                code: room.code,
                hostId: room.hostId,
                players: lobbyPlayers(room),
                settings: room.settings
            });

            return;
        }

        // 방 참가
        if (msg.type === "join") {

            if (ws.player) return;

            const code =
                String(msg.code || "").trim();

            const room = rooms.get(code);

            if (!room) {
                send(ws, "error", {
                    message: "존재하지 않는 방입니다."
                });
                return;
            }

            if (room.started) {
                send(ws, "error", {
                    message: "이미 게임이 시작된 방입니다."
                });
                return;
            }

            if (room.players.size >= 10) {
                send(ws, "error", {
                    message: "방이 가득 찼습니다."
                });
                return;
            }

            const name =
                String(msg.name || "플레이어")
                    .slice(0, 16);

            const player = {
                id,
                ws,
                roomCode: code,
                name,
                color: COLORS[room.players.size % COLORS.length],
                x: 500,
                y: 400,
                role: null,
                alive: true,
                tasks: [],
                completedTasks: 0,
                killCooldown: 0
            };

            room.players.set(player.id, player);

            ws.player = player;

            send(ws, "joined", {
                code,
                playerId: player.id,
                host: false,
                color: player.color,
                settings: room.settings
            });

            broadcast(room, "lobby", {
                code,
                hostId: room.hostId,
                players: lobbyPlayers(room),
                settings: room.settings
            });

            return;
        }

        handleMessage(ws, msg);
    });

    ws.on("close", () => {

        const player = ws.player;

        if (!player) return;

        const room = rooms.get(player.roomCode);

        if (!room) return;

        room.players.delete(player.id);

        if (room.players.size === 0) {
            rooms.delete(room.code);
            return;
        }

        // 방장이 나가면 다음 사람에게 방장 넘김
        if (room.hostId === player.id) {
            const next = room.players.values().next().value;

            if (next) {
                room.hostId = next.id;
            }
        }

        broadcast(room, "lobby", {
            code: room.code,
            hostId: room.hostId,
            players: lobbyPlayers(room),
            settings: room.settings
        });

        if (room.started) {
            checkWin(room);
        }
    });
});

server.listen(PORT, () => {
    console.log("");
    console.log("================================");
    console.log(" Among Us V3 Server");
    console.log("================================");
    console.log(`http://localhost:${PORT}`);
    console.log("");
});
