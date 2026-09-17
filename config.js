/* Poker Tracker — sharing settings.
 *
 * With POKER_CONFIG set, every visitor reads and writes ONE live table in Firebase
 * Realtime Database. Set it to null to fall back to per-browser local storage.
 *
 * These values are meant to be public (they identify the project, they don't grant
 * access by themselves). Access is controlled by the database rules, see README.
 */
window.POKER_CONFIG = {
  tableId: 'main',                       // change to e.g. 'season-2027' to start a fresh table
  firebase: {
    apiKey: 'AIzaSyCA_Sud3yBaOW5Vj5xXwEoKja579JEcjO0',
    authDomain: 'poker-tracker-bcd8c.firebaseapp.com',
    databaseURL: 'https://poker-tracker-bcd8c-default-rtdb.firebaseio.com',
    projectId: 'poker-tracker-bcd8c',
    storageBucket: 'poker-tracker-bcd8c.firebasestorage.app',
    messagingSenderId: '1017780386035',
    appId: '1:1017780386035:web:b790dd7fd6f5e9a7f3df86'
  }
};
