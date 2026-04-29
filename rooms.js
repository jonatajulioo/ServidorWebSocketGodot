const rooms = new Map();

function createRoom(socket, playerlist, generateRoomCode) {
    let code = generateRoomCode();

    while (rooms.has(code)) {
        code = generateRoomCode();
    }

    rooms.set(code, {
        players: {},
        hostId: socket.uuid,
        hostUserId: socket.userId,
        status: "waiting",
        selectedCountries: {},
        selectedColors: {},
        gameState: null
    });

    return code;
}

module.exports = { rooms, createRoom };