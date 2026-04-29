const playerlist = {
    players: [],

    get(uuid) {
        return this.players.find((p) => p.uuid === uuid);
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
        this.players = this.players.filter((p) => p.uuid !== uuid);
    },

    removeByRoom(roomCode) {
        this.players = this.players.filter((p) => p.room !== roomCode);
    },

    getByRoom(roomCode) {
        return this.players.filter((p) => p.room === roomCode);
    }
};

module.exports = playerlist;