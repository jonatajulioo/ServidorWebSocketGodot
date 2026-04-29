const playerlist = {
    players: [],

    getAll() {
        return this.players;
    },

    get(uuid) {
        return this.players.find((player) => player.uuid === uuid);
    },

    getByUserId(userId) {
        return this.players.find((player) => player.userId === userId);
    },

    add(uuid, userId, roomCode, playerName) {
        const player = {
            uuid,
            userId,
            room: roomCode,
            name: playerName,
            country: null,
            color: null
        };

        this.players.push(player);
        return player;
    },

    remove(uuid) {
        this.players = this.players.filter((player) => player.uuid !== uuid);
    },

    removeByRoom(roomCode) {
        this.players = this.players.filter((player) => player.room !== roomCode);
    },

    getByRoom(roomCode) {
        return this.players.filter((player) => player.room === roomCode);
    }
};

module.exports = playerlist;