// Relay (TURN) servers, for players whose networks can't reach each other directly: most often a phone on
// mobile data joining a game hosted on home WiFi. Without one, online play only works when the networks allow
// a direct link. The free relays PeerJS used to provide shut down in 2023, so this needs a relay account.
//
// A free one: sign up at https://www.expressturn.com, then copy the TURN server, username and password from
// its dashboard (not your account's login password) into the list, like this:
//
//   { urls: ['turn:relay1.expressturn.com:3478', 'turn:relay1.expressturn.com:3478?transport=tcp'], username: '…', credential: '…' },
//
// Anyone who opens the game can see these, which is how browser games use relays; the worst a stranger could
// do with them is use up the account's free monthly allowance.
export const RELAYS = [];
