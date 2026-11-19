const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../js/store.js');

// What choosing a backup file in the import dialog does.
const restore = (store, text) => store.importBackup(S.readImport(text));

test('normTitle ignores case, accents, punctuation and edition notes', () => {
  assert.equal(S.normTitle('OK Computer (Remastered 2009)'), S.normTitle('ok computer'));
  assert.equal(S.normTitle('Rumours [Deluxe Edition]'), 'rumours');
  assert.equal(S.normTitle('Ágætis byrjun'), S.normTitle('Agaetis Byrjun'));
  assert.notEqual(S.normTitle('Help! (Live)'), S.normTitle('Help!'));
  assert.equal(S.normTitle('風の谷のナウシカ'), '風の谷のナウシカ');
});

test('normArtist drops a leading "The" and treats & as "and"', () => {
  assert.equal(S.normArtist('The Beatles'), S.normArtist('beatles'));
  assert.equal(S.normArtist('Simon & Garfunkel'), S.normArtist('Simon and Garfunkel'));
  assert.equal(S.normArtist('!!!'), '!!!');
});

test('records are cleaned, saved and read back', () => {
  const storage = S.memoryStorage();
  const first = S.createStore(storage);
  const record = first.add({ artist: ' Radiohead ', title: 'OK Computer', year: '1997-05-21' });
  assert.equal(record.artist, 'Radiohead');
  assert.equal(record.year, 1997);
  assert.equal(record.format, 'LP');

  const second = S.createStore(storage);
  assert.equal(second.all().length, 1);
  second.update(record.id, { format: 'CD', notes: 'Japan pressing' });
  assert.equal(second.get(record.id).format, 'CD');
  assert.equal(second.get(record.id).addedAt, record.addedAt);

  assert.throws(() => second.add({ artist: '', title: 'No artist' }), /required/);
  assert.throws(() => second.update(record.id, { title: ' ' }), /required/);
  assert.equal(second.get(record.id).title, 'OK Computer');

  second.remove(record.id);
  assert.equal(S.createStore(storage).all().length, 0);
});

test('you can only add one copy of an album', () => {
  const store = S.createStore(S.memoryStorage());
  store.add({ artist: 'Weezer', title: 'Pinkerton', releaseGroupId: 'pink', format: 'LP' });
  store.add({ artist: 'Radiohead', title: 'The Bends', format: 'LP' });

  assert.throws(() => store.add({ artist: 'Weezer', title: 'Pinkerton', releaseGroupId: 'pink', format: 'CD' }), /"Pinkerton" is already in your collection/);
  assert.throws(() => store.add({ artist: 'weezer', title: 'pinkerton' }), /already/, 'typed in by hand');
  assert.throws(() => store.add({ artist: 'Radiohead', title: 'The Bends (Remastered)' }), /already/, 'a remaster is the same album');
  assert.ok(store.findCopy({ artist: 'Radiohead', title: 'The Bends', releaseGroupId: 'bends' }));

  // Different albums are fine: a deluxe edition, and a different album with the same title
  store.add({ artist: 'Weezer', title: 'Pinkerton (Deluxe Edition)', releaseGroupId: 'pink' });
  store.add({ artist: 'Weezer', title: 'Weezer', releaseGroupId: 'blue' });
  store.add({ artist: 'Weezer', title: 'Weezer', releaseGroupId: 'green' });
  assert.equal(store.all().length, 5);
  assert.equal(store.findCopy({ artist: 'Weezer', title: 'Weezer', releaseGroupId: 'red' }), null);
});

test('only vinyl formats are offered', () => {
  assert.deepEqual(S.FORMATS, ['LP', 'Double LP', 'EP', '45', '10"', '12" single', 'Box set', 'Other']);
  assert.deepEqual(S.SMALL_FORMATS, ['45', '10"']);
});

test('records saved as 7" singles are called 45s now', () => {
  const storage = S.memoryStorage();
  storage.setItem(S.KEYS.records, JSON.stringify([{ id: 'r1', artist: 'The Beatles', title: 'Help!', format: '7" single' }]));
  storage.setItem(S.KEYS.wishlist, JSON.stringify([{ id: 'w1', artist: 'The Beatles', title: 'Ticket to Ride', format: '7" single' }]));
  const store = S.createStore(storage);
  assert.equal(store.get('r1').format, '45');
  assert.equal(store.wishlist()[0].format, '45');
  assert.equal(store.add({ artist: 'The Beatles', title: 'Day Tripper', format: '7" single' }).format, '45');
});

test('the wishlist holds records you want, apart from the collection', () => {
  const storage = S.memoryStorage();
  const store = S.createStore(storage);
  store.add({ artist: 'Weezer', title: 'Weezer', releaseGroupId: 'blue' });
  const wish = store.addToWishlist({ artist: 'Weezer', title: 'Pinkerton', releaseGroupId: 'pink' });
  store.addToWishlist({ artist: 'Weezer', title: 'Pinkerton (Deluxe Edition)', releaseGroupId: 'pink' });

  assert.equal(store.all().length, 1, 'wishes are not in the collection');
  assert.deepEqual(store.wishlist().map((w) => w.title), ['Pinkerton', 'Pinkerton (Deluxe Edition)']);
  assert.equal(store.findWish({ artist: 'weezer', title: 'pinkerton' }).id, wish.id);
  assert.throws(() => store.addToWishlist({ artist: 'Weezer', title: 'Pinkerton', releaseGroupId: 'pink' }), /already on your wishlist/);
  assert.throws(() => store.addToWishlist({ artist: 'Weezer', title: 'Weezer', releaseGroupId: 'blue' }), /already in your collection/);
  assert.equal(S.createStore(storage).wishlist().length, 2, 'the wishlist is saved');

  // Getting a record takes it off the wishlist, edition by edition
  store.add({ artist: 'Weezer', title: 'Pinkerton', releaseGroupId: 'pink' });
  assert.deepEqual(store.wishlist().map((w) => w.title), ['Pinkerton (Deluxe Edition)']);

  const [deluxe] = store.wishlist();
  assert.equal(store.removeFromWishlist(deluxe.id).title, 'Pinkerton (Deluxe Edition)');
  assert.deepEqual(store.wishlist(), []);
  assert.equal(store.removeFromWishlist('gone'), null);
});

test('you can confirm a release came out on vinyl, and owning it on vinyl confirms it too', () => {
  const storage = S.memoryStorage();
  const store = S.createStore(storage);
  assert.equal(S.vinylKey('gone-now', false), 'gone-now');
  assert.equal(S.vinylKey('gone-now', true), 'gone-now:deluxe');
  assert.equal(S.vinylKey(null, false), null);

  assert.equal(store.isVinylConfirmed('gone-now'), false);
  store.confirmVinyl('gone-now');
  assert.equal(store.isVinylConfirmed('gone-now'), true);
  assert.equal(store.confirmedByYou('gone-now'), true);
  assert.equal(store.isVinylConfirmed('gone-now:deluxe'), false, 'the deluxe edition is confirmed separately');
  assert.equal(S.createStore(storage).isVinylConfirmed('gone-now'), true, 'confirmations are saved');
  store.unconfirmVinyl('gone-now');
  assert.equal(store.isVinylConfirmed('gone-now'), false);

  // Owning it on vinyl counts, edition by edition; a record of format "Other" doesn't
  store.add({ artist: 'Bleachers', title: 'Strange Desire', releaseGroupId: 'strange', format: 'LP' });
  store.add({ artist: 'Bleachers', title: 'Bleachers (Deluxe Edition)', releaseGroupId: 'bleachers', format: 'Double LP' });
  store.add({ artist: 'Bleachers', title: 'Terrible Thrills', releaseGroupId: 'thrills', format: 'Other' });
  assert.equal(store.isVinylConfirmed('strange'), true);
  assert.equal(store.confirmedByYou('strange'), false, 'not something you confirmed by hand');
  assert.equal(store.isVinylConfirmed('bleachers:deluxe'), true);
  assert.equal(store.isVinylConfirmed('bleachers'), false);
  assert.equal(store.isVinylConfirmed('thrills'), false);
});

test('backups carry vinyl confirmations', () => {
  const source = S.createStore(S.memoryStorage());
  source.confirmVinyl('gone-now');
  const target = S.createStore(S.memoryStorage());
  restore(target, source.exportJSON());
  assert.equal(target.confirmedByYou('gone-now'), true);
});

test('backups carry the wishlist too', () => {
  const source = S.createStore(S.memoryStorage());
  source.add({ artist: 'Weezer', title: 'Weezer', releaseGroupId: 'blue' });
  source.addToWishlist({ artist: 'Weezer', title: 'Pinkerton', releaseGroupId: 'pink' });
  source.addToWishlist({ artist: 'Weezer', title: 'Maladroit', releaseGroupId: 'mal' });

  const target = S.createStore(S.memoryStorage());
  target.add({ artist: 'Weezer', title: 'Maladroit', releaseGroupId: 'mal' }); // already have it here
  assert.deepEqual(restore(target, source.exportJSON()), { added: 1, skipped: 0, wishes: 1 });
  assert.deepEqual(target.wishlist().map((w) => w.title), ['Pinkerton'], 'albums you already have stay off the wishlist');
});

test('changing the artist name drops the old MusicBrainz artist link', () => {
  const store = S.createStore(S.memoryStorage());
  const record = store.add({ artist: 'Radiohead', title: 'Kid A', artistId: 'a1' });
  assert.equal(store.update(record.id, { artist: 'radiohead' }).artistId, 'a1');
  assert.equal(store.update(record.id, { artist: 'Thom Yorke' }).artistId, null);
});

test('a cover color is saved with the record without redrawing anything', () => {
  const storage = S.memoryStorage();
  const store = S.createStore(storage);
  const record = store.add({ artist: 'Radiohead', title: 'Kid A', releaseGroupId: 'rg-kida' });
  assert.equal(record.coverColor, null);
  let changes = 0;
  store.onChange(() => changes++);
  store.setCoverColor(record.id, 'rgb(12 34 56)');
  assert.equal(changes, 0, 'nothing on screen depends on it');
  assert.equal(store.get(record.id).coverColor, 'rgb(12 34 56)');
  assert.equal(S.createStore(storage).get(record.id).coverColor, 'rgb(12 34 56)', 'saved for next time');
  // Only colors in the form the app reads them are kept
  store.setCoverColor(record.id, 'red; background: url(x)');
  store.setCoverColor('no-such-record', 'rgb(1 2 3)');
  assert.equal(store.get(record.id).coverColor, 'rgb(12 34 56)');
  assert.equal(store.add({ artist: 'Radiohead', title: 'Amnesiac', coverColor: 'url(x)' }).coverColor, null);
});

test('a cover color goes with a new cover, and backups carry it', () => {
  const store = S.createStore(S.memoryStorage());
  const record = store.add({ artist: 'Radiohead', title: 'Kid A', releaseGroupId: 'rg-kida' });
  store.setCoverColor(record.id, 'rgb(12 34 56)');
  assert.equal(store.update(record.id, { notes: 'First pressing' }).coverColor, 'rgb(12 34 56)');

  const copy = S.createStore(S.memoryStorage());
  restore(copy, store.exportJSON());
  assert.equal(copy.all()[0].coverColor, 'rgb(12 34 56)');
  // Backups made before colors were saved still load
  restore(copy, JSON.stringify([{ artist: 'Portishead', title: 'Dummy' }]));
  assert.equal(copy.all()[1].coverColor, null);

  assert.equal(store.update(record.id, { releaseGroupId: 'rg-kida-deluxe' }).coverColor, null, 'the old color belongs to the old cover');
});

test('linkArtist fills in the artist id only on unlinked records with that name', () => {
  const store = S.createStore(S.memoryStorage());
  store.add({ artist: 'Nirvana', title: 'Nevermind' });
  store.add({ artist: 'nirvana', title: 'In Utero' });
  store.add({ artist: 'Nirvana', title: 'Local Anaesthetic', artistId: 'uk-nirvana' });
  store.add({ artist: 'Hole', title: 'Live Through This' });
  assert.equal(store.linkArtist('Nirvana', 'us-nirvana'), 2);
  const ids = store.all().map((r) => r.artistId);
  assert.deepEqual(ids, ['us-nirvana', 'us-nirvana', 'uk-nirvana', null]);
});

test('backups round trip and do not create duplicates', () => {
  const source = S.createStore(S.memoryStorage());
  source.add({ artist: 'Björk', title: 'Homogenic', format: 'Double LP' });
  source.add({ artist: 'Portishead', title: 'Dummy' });
  const backup = source.exportJSON();

  const target = S.createStore(S.memoryStorage());
  assert.deepEqual(restore(target, backup), { added: 2, skipped: 0, wishes: 0 });
  assert.deepEqual(restore(target, backup), { added: 0, skipped: 2, wishes: 0 });
  assert.equal(target.all()[0].format, 'Double LP');
  assert.deepEqual(restore(target, JSON.stringify([{ artist: 'Low', title: 'Things We Lost in the Fire' }, { title: 'No artist' }, { artist: 'low', title: 'things we lost in the fire' }])), { added: 1, skipped: 2, wishes: 0 });
  // A backup from another device skips albums you already have, even with different ids
  assert.deepEqual(restore(target, JSON.stringify([{ id: 'other-device', artist: 'portishead', title: 'Dummy' }])), { added: 0, skipped: 1, wishes: 0 });
  assert.throws(() => restore(target, '{"records": [}'), /valid backup/);
  assert.throws(() => restore(target, '{"hello": 1}'), /look like/);
});

test('fileContent reads UTF-8 and the encodings Excel saves text in', async () => {
  assert.equal(await S.fileContent(new TextEncoder().encode('﻿Artist,Title\nMotörhead,Ace of Spades')), 'Artist,Title\nMotörhead,Ace of Spades');
  const windows1252 = Uint8Array.from([...'Motörhead - Ace of Spades\nGuns N’ Roses - Appetite'], (ch) => (ch === '’' ? 0x92 : ch.charCodeAt(0)));
  assert.equal(await S.fileContent(windows1252), 'Motörhead - Ace of Spades\nGuns N’ Roses - Appetite', 'CSV saved by Excel on Windows');
  const utf16 = Uint8Array.from([0xff, 0xfe, ...Buffer.from('Artist\tTitle\nBjörk\tPost', 'utf16le')]);
  assert.equal(await S.fileContent(utf16), 'Artist\tTitle\nBjörk\tPost', 'Unicode Text saved by Excel');
});

const fixture = (name) => new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', name)));

test('fileContent reads the first sheet of an .xlsx file, and readImport reads it like a CSV', async () => {
  const read = S.readImport(await S.fileContent(fixture('records-xlsxwriter.xlsx')));
  assert.equal(read.kind, 'table');
  assert.deepEqual(read.columns, ['Artist', 'Album', 'Year', 'Format', 'Label', 'Notes']);
  assert.deepEqual(read.notVinyl, ['Björk, Post, 1995, CD']);
  assert.deepEqual(read.items, [
    { artist: 'Steely Dan', title: 'Aja', year: 1977, format: 'LP', notes: 'Label: ABC' },
    { artist: 'Motörhead', title: 'Ace of Spades', year: 1980, format: '45', notes: 'Signed; Label: Bronze' },
    { artist: 'Crosby, Stills & Nash', title: 'Crosby, Stills & Nash', year: 1969, format: 'LP', notes: 'Gatefold\nfirst press; Label: Atlantic' },
    { artist: 'Rush', title: 'Moving Pictures', year: 1981, format: 'Double LP', notes: '' },
    { artist: 'Weezer', title: 'Pinkerton', year: 1996, format: 'LP', notes: '' },
  ], 'a date in the Year column gives its year, and the second sheet is not read');
});

test('fileContent gives every cell of an .xlsx row as text, and reads a number as a date only when its format is a date', async () => {
  const rows = await S.fileContent(fixture('records-xlsxwriter-gaps.xlsx'));
  assert.deepEqual(rows, [['Artist', 'Album', 'Year', 'Format'], ['Portishead', 'Portishead', '', 'LP'], ['Steely Dan', 'Gaucho', '1980', 'LP']],
    'an empty cell in the middle is an empty string, and 0 "AD" is a number format, not a date');
});

test('fileContent reads the first sheet whose first row names the columns, or else the first sheet', async () => {
  const summaryFirst = S.readImport(await S.fileContent(fixture('records-summary-first.xlsx')));
  assert.deepEqual([summaryFirst.kind, summaryFirst.items.map((item) => `${item.artist} - ${item.title}`)], ['table', ['Steely Dan - Aja', 'Rush - Signals']],
    'a Summary sheet before the records is passed over');
  const noNames = S.readImport(await S.fileContent(fixture('records-no-column-names.xlsx')));
  assert.deepEqual([noNames.kind, noNames.items.map((item) => `${item.artist} - ${item.title}`)], ['list', ['Steely Dan - Gaucho']],
    'with no column names anywhere, the first sheet reads like two columns pasted in');
});

test('fileContent reads .xlsx files from LibreOffice and from workbooks dated from 1904', async () => {
  const libreoffice = S.readImport(await S.fileContent(fixture('records-libreoffice.xlsx')));
  assert.deepEqual(libreoffice.items.map((item) => [item.title, item.year]), [['Dummy', 1994], ['Kid A', 2000]]);
  const mac = S.readImport(await S.fileContent(fixture('records-openpyxl-1904.xlsx')));
  assert.deepEqual(mac.items, [{ artist: 'Pink Floyd', title: 'The Dark Side of the Moon', year: 1973, format: null, notes: '' }]);
});

test('fileContent says to save as CSV for Numbers, old Excel, damaged files and browsers that cannot unzip', async () => {
  await assert.rejects(S.fileContent(fixture('records.numbers')), /can't read Numbers or old Excel \(\.xls\) files/);
  await assert.rejects(S.fileContent(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1])), /can't read Numbers or old Excel \(\.xls\) files/);
  await assert.rejects(S.fileContent(fixture('records-xlsxwriter.xlsx').slice(0, 2000)), /couldn't be read\. Save the sheet as CSV/);
  const unzip = globalThis.DecompressionStream;
  delete globalThis.DecompressionStream;
  try {
    await assert.rejects(S.fileContent(fixture('records-xlsxwriter.xlsx')), /This browser can't open Excel files\. Save the sheet as CSV/);
  } finally {
    globalThis.DecompressionStream = unzip;
  }
});

test('readImport knows a backup from a list that starts with a bracket', () => {
  const source = S.createStore(S.memoryStorage());
  source.add({ artist: 'Portishead', title: 'Dummy', releaseGroupId: 'rg-dummy' });
  source.addToWishlist({ artist: 'Portishead', title: 'Third' });
  const backup = S.readImport(source.exportJSON());
  assert.equal(backup.kind, 'backup');
  assert.deepEqual([backup.records.map((r) => r.releaseGroupId), backup.wishlist.map((w) => w.title)], [['rg-dummy'], ['Third']]);
  assert.deepEqual(S.readImport('[]').records, [], 'an empty backup from an early version');
  const list = S.readImport('[Signed] Rush - 2112');
  assert.deepEqual([list.kind, list.items[0].artist], ['list', '[Signed] Rush']);
});

test('records remember when they last changed', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  const storage = S.memoryStorage();
  const store = S.createStore(storage);
  const record = store.add({ artist: 'Steely Dan', title: 'Aja' });
  assert.equal(record.updatedAt, '2026-01-01T00:00:00.000Z');

  t.mock.timers.setTime(Date.parse('2026-02-01T00:00:00Z'));
  store.update(record.id, { notes: 'Signed' });
  t.mock.timers.setTime(Date.parse('2026-03-01T00:00:00Z'));
  const saved = S.createStore(storage).get(record.id);
  assert.equal(saved.updatedAt, '2026-02-01T00:00:00.000Z');
  assert.equal(saved.addedAt, '2026-01-01T00:00:00.000Z');

  store.linkArtist('Steely Dan', 'sd');
  assert.equal(store.get(record.id).updatedAt, '2026-03-01T00:00:00.000Z');

  t.mock.timers.setTime(Date.parse('2026-04-01T00:00:00Z'));
  const wish = store.addToWishlist({ artist: 'Can', title: 'Ege Bamyasi' });
  t.mock.timers.setTime(Date.parse('2026-05-01T00:00:00Z'));
  store.removeFromWishlist(wish.id);
  const got = store.add({ ...wish, id: null, addedAt: null });
  assert.equal(got.updatedAt, '2026-05-01T00:00:00.000Z', 'a wish you got counts as changed when you got it');
});

test('backups keep the time each record last changed', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  const source = S.createStore(S.memoryStorage());
  source.add({ artist: 'Steely Dan', title: 'Aja' });

  t.mock.timers.setTime(Date.parse('2026-06-01T00:00:00Z'));
  const target = S.createStore(S.memoryStorage());
  restore(target, source.exportJSON());
  restore(target, JSON.stringify([{ artist: 'Can', title: 'Tago Mago', addedAt: '2020-05-05T00:00:00.000Z' }]));
  const byTitle = Object.fromEntries(target.all().map((r) => [r.title, r.updatedAt]));
  assert.equal(byTitle.Aja, '2026-01-01T00:00:00.000Z');
  assert.equal(byTitle['Tago Mago'], '2020-05-05T00:00:00.000Z', 'an older backup counts from when the record was added');
});

test('deleting leaves a marker with the time, and adding it back clears the marker', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  const storage = S.memoryStorage();
  const store = S.createStore(storage);
  const aja = store.add({ artist: 'Steely Dan', title: 'Aja' });
  const gaucho = store.add({ artist: 'Steely Dan', title: 'Gaucho' });
  const wish = store.addToWishlist({ artist: 'Can', title: 'Tago Mago' });
  const gotIt = store.addToWishlist({ artist: 'Can', title: 'Ege Bamyasi' });
  store.confirmVinyl('rg-x');

  t.mock.timers.setTime(Date.parse('2026-02-01T00:00:00Z'));
  const at = '2026-02-01T00:00:00.000Z';
  store.remove(aja.id);
  store.removeMany([gaucho.id]);
  store.removeFromWishlist(wish.id);
  store.add({ ...gotIt, id: null, addedAt: null });
  store.unconfirmVinyl('rg-x');
  assert.deepEqual(S.createStore(storage).syncState().deleted, {
    records: { [aja.id]: at, [gaucho.id]: at },
    wishlist: { [wish.id]: at, [gotIt.id]: at },
    confirmed: { 'rg-x': at },
  });

  t.mock.timers.setTime(Date.parse('2026-03-01T00:00:00Z'));
  store.add(aja);
  store.addToWishlist(wish);
  store.confirmVinyl('rg-x');
  const state = S.createStore(storage).syncState();
  assert.deepEqual(state.deleted, { records: { [gaucho.id]: at }, wishlist: { [gotIt.id]: at }, confirmed: {} });
  assert.equal(state.confirmed['rg-x'], '2026-03-01T00:00:00.000Z');
});

test('confirmations saved before they had times are kept, with an unknown time', () => {
  const storage = S.memoryStorage();
  storage.setItem('recordcatalog.confirmed.v1', JSON.stringify(['rg-a', 'rg-b:deluxe']));
  const store = S.createStore(storage);
  assert.equal(store.confirmedByYou('rg-a'), true);
  assert.deepEqual(store.syncState().confirmed, { 'rg-a': '1970-01-01T00:00:00.000Z', 'rg-b:deluxe': '1970-01-01T00:00:00.000Z' });
  assert.equal(S.createStore(storage).confirmedByYou('rg-b:deluxe'), true, 'still there the next time the app opens');
});

test('importing a backup brings back what you deleted, as a change made now', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  const store = S.createStore(S.memoryStorage());
  const aja = store.add({ artist: 'Steely Dan', title: 'Aja' });
  const wish = store.addToWishlist({ artist: 'Can', title: 'Tago Mago' });
  store.confirmVinyl('rg-x');
  const backup = store.exportJSON();

  t.mock.timers.setTime(Date.parse('2026-02-01T00:00:00Z'));
  store.remove(aja.id);
  store.removeFromWishlist(wish.id);
  store.unconfirmVinyl('rg-x');
  t.mock.timers.setTime(Date.parse('2026-03-01T00:00:00Z'));
  restore(store, backup);
  const state = store.syncState();
  assert.equal(state.records[0].updatedAt, '2026-03-01T00:00:00.000Z');
  assert.equal(state.wishlist[0].updatedAt, '2026-03-01T00:00:00.000Z');
  assert.equal(state.confirmed['rg-x'], '2026-03-01T00:00:00.000Z');
  assert.deepEqual(state.deleted, { records: {}, wishlist: {}, confirmed: {} });

  const elsewhere = S.createStore(S.memoryStorage());
  restore(elsewhere, backup);
  assert.equal(elsewhere.syncState().confirmed['rg-x'], '1970-01-01T00:00:00.000Z', 'a backup does not say when you confirmed');
});

const at = (month) => `2026-${String(month).padStart(2, '0')}-01T00:00:00.000Z`;
const steelyDan = (id, title, fields = {}) => ({ id, artist: 'Steely Dan', title, format: 'LP', addedAt: at(1), ...fields });
function syncState({ records = [], wishlist = [], confirmed = {}, deleted = {} } = {}) {
  return { records, wishlist, confirmed, deleted: { records: {}, wishlist: {}, confirmed: {}, ...deleted } };
}
const titles = (list) => list.map((record) => record.title);

test('a merge keeps the newer copy of each record, as a whole, and every record from either side', () => {
  const mine = syncState({ records: [steelyDan('aja', 'Aja', { notes: 'Signed', updatedAt: at(2) }), steelyDan('gaucho', 'Gaucho')] });
  const theirs = syncState({ records: [steelyDan('aja', 'Aja', { format: 'Double LP', notes: '', updatedAt: at(3) }), steelyDan('katy', 'Katy Lied')] });
  const merged = S.mergeSyncStates(mine, theirs);
  assert.deepEqual(merged.records.find((r) => r.id === 'aja'), theirs.records[0]);
  assert.deepEqual(merged.records.map((r) => r.id).sort(), ['aja', 'gaucho', 'katy']);
});

test('a record saved before records had a change time counts from when it was added', () => {
  const mine = syncState({ records: [steelyDan('aja', 'Aja', { addedAt: at(3) }), steelyDan('gaucho', 'Gaucho', { addedAt: at(1) })] });
  const theirs = syncState({ deleted: { records: { aja: at(2), gaucho: at(2) } } });
  assert.deepEqual(titles(S.mergeSyncStates(mine, theirs).records), ['Aja']);
});

test('a deletion wins over any copy that is not newer, and a later edit brings the record back', () => {
  const mine = syncState({ records: [steelyDan('aja', 'Aja', { updatedAt: at(2) }), steelyDan('gaucho', 'Gaucho', { updatedAt: at(4) }), steelyDan('katy', 'Katy Lied', { updatedAt: at(3) })] });
  const theirs = syncState({ deleted: { records: { aja: at(3), gaucho: at(3), katy: at(3) } } });
  const merged = S.mergeSyncStates(mine, theirs);
  assert.deepEqual(titles(merged.records), ['Gaucho']);
  assert.deepEqual(merged.deleted.records, { aja: at(3), katy: at(3) }, 'a deletion at the same moment as an edit wins');

  const deletedTwice = S.mergeSyncStates(syncState({ deleted: { records: { aja: at(2) } } }), syncState({ deleted: { records: { aja: at(4) } } }));
  const editedBetween = syncState({ records: [steelyDan('aja', 'Aja', { updatedAt: at(3) })] });
  assert.deepEqual(S.mergeSyncStates(deletedTwice, editedBetween).records, [], 'the later of two deletions counts');
});

test('the wishlist merges the same way as the records', () => {
  const mine = syncState({ wishlist: [steelyDan('w1', 'Aja', { notes: 'Any pressing', updatedAt: at(2) }), steelyDan('w2', 'Gaucho', { updatedAt: at(2) })] });
  const theirs = syncState({ wishlist: [steelyDan('w1', 'Aja', { notes: 'Japan pressing', updatedAt: at(3) })], deleted: { wishlist: { w2: at(3) } } });
  const merged = S.mergeSyncStates(mine, theirs);
  assert.deepEqual(merged.wishlist.map((w) => w.notes), ['Japan pressing']);
  assert.deepEqual(merged.deleted.wishlist, { w2: at(3) });
});

test('a vinyl confirmation follows the latest change on either device', () => {
  const mine = syncState({ confirmed: { 'rg-a': at(1), 'rg-old': '1970-01-01T00:00:00.000Z' }, deleted: { confirmed: { 'rg-b': at(2) } } });
  const theirs = syncState({ confirmed: { 'rg-b': at(3), 'rg-c': at(1) }, deleted: { confirmed: { 'rg-a': at(2), 'rg-old': at(1) } } });
  const merged = S.mergeSyncStates(mine, theirs);
  assert.deepEqual(merged.confirmed, { 'rg-b': at(3), 'rg-c': at(1) });
  assert.deepEqual(merged.deleted.confirmed, { 'rg-a': at(2), 'rg-old': at(1) });
});

test('a merge keeps one copy per album, the one added first', () => {
  const mine = syncState({ records: [
    steelyDan('m-aja', 'Aja', { releaseGroupId: 'rg-aja', addedAt: at(2) }),
    steelyDan('m-gaucho', 'gaucho', { addedAt: at(1) }),
  ] });
  const theirs = syncState({ records: [
    steelyDan('t-aja', 'Aja', { releaseGroupId: 'rg-aja', notes: 'Second copy', addedAt: at(1) }),
    steelyDan('t-gaucho', 'Gaucho (Remastered)', { releaseGroupId: 'rg-gaucho', addedAt: at(2) }),
    steelyDan('t-aja-deluxe', 'Aja (Deluxe Edition)', { releaseGroupId: 'rg-aja', addedAt: at(3) }),
    { id: 't-blue', artist: 'Weezer', title: 'Weezer', releaseGroupId: 'rg-blue', addedAt: at(1) },
    { id: 't-green', artist: 'Weezer', title: 'Weezer', releaseGroupId: 'rg-green', addedAt: at(2) },
    { id: 't-typed', artist: 'weezer', title: 'weezer', addedAt: at(3) },
  ] });
  const merged = S.mergeSyncStates(mine, theirs);
  assert.deepEqual(merged.records.map((r) => r.id), ['m-gaucho', 't-aja', 't-blue', 't-green', 't-aja-deluxe']);
  for (const [i, a] of merged.records.entries()) {
    for (const b of merged.records.slice(i + 1)) assert.equal(S.sameAlbum(a, b), false, `${a.id} and ${b.id} are the same album`);
  }
  const wishes = S.mergeSyncStates(syncState({ wishlist: [steelyDan('w1', 'Aja', { addedAt: at(2) })] }), syncState({ wishlist: [steelyDan('w2', 'aja', { addedAt: at(1) })] }));
  assert.deepEqual(wishes.wishlist.map((w) => w.id), ['w2'], 'the wishlist keeps one copy too');
});

test('a merge takes a wish off the wishlist when you own the album', () => {
  const mine = syncState({ records: [steelyDan('aja', 'Aja', { releaseGroupId: 'rg-aja' })] });
  const theirs = syncState({ wishlist: [steelyDan('w1', 'Aja', { releaseGroupId: 'rg-aja' }), steelyDan('w2', 'Aja (Deluxe Edition)', { releaseGroupId: 'rg-aja' })] });
  assert.deepEqual(titles(S.mergeSyncStates(mine, theirs).wishlist), ['Aja (Deluxe Edition)']);
});

test('a merge gives the same result in either order, and merging again changes nothing', () => {
  const mine = syncState({
    records: [steelyDan('aja', 'Aja', { notes: 'mine' }), steelyDan('gaucho', 'Gaucho', { updatedAt: at(2) }), steelyDan('m-katy', 'Katy Lied', { addedAt: at(2) })],
    wishlist: [steelyDan('w1', 'Pretzel Logic')],
    confirmed: { 'rg-a': at(2) },
    deleted: { records: { royal: at(2) } },
  });
  const theirs = syncState({
    records: [steelyDan('aja', 'Aja', { notes: 'theirs' }), steelyDan('royal', 'The Royal Scam', { updatedAt: at(1) }), steelyDan('t-katy', 'Katy Lied')],
    wishlist: [steelyDan('w2', 'Gaucho')],
    confirmed: { 'rg-b': at(1) },
    deleted: { records: { gaucho: at(3) }, confirmed: { 'rg-a': at(3) } },
  });
  const merged = S.mergeSyncStates(mine, theirs);
  assert.deepEqual(S.mergeSyncStates(theirs, mine), merged, 'either order');
  assert.equal(JSON.stringify(S.mergeSyncStates(theirs, mine)), JSON.stringify(merged), 'written the same way');
  assert.deepEqual(S.mergeSyncStates(merged, theirs), merged, 'merging again');
  assert.deepEqual(S.mergeSyncStates(merged, mine), merged);
  assert.deepEqual(S.mergeSyncStates(merged, merged), merged);
});

test('merging thousands of records stays fast', () => {
  const big = (prefix, offset) => syncState({ records: Array.from({ length: 3000 }, (_, i) => ({
    id: `${prefix}${i}`, artist: `Artist ${(i + offset) % 400}`, title: `Album ${i + offset}`, releaseGroupId: i % 3 ? `rg-${i + offset}` : null, addedAt: at(1),
  })) });
  const start = process.hrtime.bigint();
  const merged = S.mergeSyncStates(big('m', 0), big('t', 1500));
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(merged.records.length, 4500);
  assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
});

test('two devices that sync end up with the same collection', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at(1)) });
  const pc = S.createStore(S.memoryStorage());
  pc.add({ artist: 'Steely Dan', title: 'Aja' });
  pc.add({ artist: 'Steely Dan', title: 'Gaucho' });
  const phone = S.createStore(S.memoryStorage());
  restore(phone, pc.exportJSON());
  phone.add({ artist: 'Can', title: 'Tago Mago' });
  t.mock.timers.setTime(Date.parse('2026-01-02T00:00:00.000Z'));
  pc.add({ artist: 'Can', title: 'tago mago' });
  let copy = null;
  const sync = (device) => {
    if (copy) device.applySyncState(JSON.parse(JSON.stringify(copy)));
    copy = device.syncState();
  };

  sync(phone);
  sync(pc);
  sync(phone);
  assert.deepEqual(titles(phone.all()).sort(), ['Aja', 'Gaucho', 'Tago Mago']);
  assert.deepEqual(phone.all(), pc.all());

  t.mock.timers.setTime(Date.parse(at(2)));
  phone.remove(phone.all().find((r) => r.title === 'Gaucho').id);
  pc.update(pc.all().find((r) => r.title === 'Aja').id, { notes: 'Signed' });
  sync(phone);
  sync(pc);
  sync(phone);
  assert.deepEqual(pc.all().map((r) => [r.title, r.notes]).sort(), [['Aja', 'Signed'], ['Tago Mago', '']]);
  assert.deepEqual(phone.all(), pc.all());
});

// What importing a sync file does: Import reads it, the dialog previews it, and Sync applies it.
function receiveSyncFile(store, text) {
  const read = S.readImport(text);
  assert.equal(read.kind, 'sync');
  const preview = store.previewSyncState(read.state);
  store.applySyncState(read.state);
  return preview;
}

test('a sync file carries an edit one way and a delete the other, and importing it twice changes nothing more', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at(1)) });
  const pc = S.createStore(S.memoryStorage());
  const phone = S.createStore(S.memoryStorage());
  pc.add({ artist: 'Steely Dan', title: 'Aja' });
  pc.add({ artist: 'Steely Dan', title: 'Gaucho' });
  phone.addToWishlist({ artist: 'Can', title: 'Tago Mago' });
  assert.deepEqual(receiveSyncFile(phone, pc.exportSyncFile()), { added: 2, updated: 0, removed: 0, wishes: 0 });

  t.mock.timers.setTime(Date.parse(at(2)));
  pc.update(pc.all().find((r) => r.title === 'Aja').id, { notes: 'Signed' });
  phone.remove(phone.all().find((r) => r.title === 'Gaucho').id);
  assert.deepEqual(receiveSyncFile(pc, phone.exportSyncFile()), { added: 0, updated: 0, removed: 1, wishes: 1 });
  assert.deepEqual(receiveSyncFile(phone, pc.exportSyncFile()), { added: 0, updated: 1, removed: 0, wishes: 0 });
  for (const device of [pc, phone]) {
    assert.deepEqual(device.all().map((r) => [r.title, r.notes]), [['Aja', 'Signed']]);
    assert.deepEqual(titles(device.wishlist()), ['Tago Mago']);
  }

  const file = pc.exportSyncFile();
  let changes = 0;
  phone.onChange(() => changes++);
  assert.deepEqual(receiveSyncFile(phone, file), { added: 0, updated: 0, removed: 0, wishes: 0 });
  assert.deepEqual(receiveSyncFile(phone, file), { added: 0, updated: 0, removed: 0, wishes: 0 });
  assert.equal(changes, 0, 'importing the same sync file again changes nothing');
});

test('Import tells a sync file from a backup', () => {
  const store = S.createStore(S.memoryStorage());
  store.add({ artist: 'Steely Dan', title: 'Aja' });
  assert.equal(S.readImport(store.exportSyncFile()).kind, 'sync');
  assert.equal(S.readImport(store.exportJSON()).kind, 'backup');
  assert.throws(() => S.readImport('{"kind": "sync"}'), /look like/, 'only a file this app marked is a sync file');
});

test('a sync preview counts what you would see change, not cover colors or change times', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at(1)) });
  const pc = S.createStore(S.memoryStorage());
  const aja = pc.add({ artist: 'Steely Dan', title: 'Aja', releaseGroupId: 'rg-aja' });
  const phone = S.createStore(S.memoryStorage());
  phone.applySyncState(pc.syncState());
  pc.setCoverColor(aja.id, 'rgb(12 34 56)');
  t.mock.timers.setTime(Date.parse(at(2)));
  pc.update(aja.id, {});
  assert.deepEqual(phone.previewSyncState(pc.syncState()), { added: 0, updated: 0, removed: 0, wishes: 0 });
});

test('applySyncState saves the merge and tells the app only when something changed', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at(1)) });
  const storage = S.memoryStorage();
  const store = S.createStore(storage);
  const gaucho = store.add({ artist: 'Steely Dan', title: 'Gaucho' });
  let changes = 0;
  store.onChange(() => changes++);
  const theirs = syncState({ records: [steelyDan('katy', 'Katy Lied')], deleted: { records: { [gaucho.id]: at(2) } } });

  store.applySyncState(theirs);
  assert.deepEqual(titles(S.createStore(storage).all()), ['Katy Lied']);
  assert.equal(changes, 1);
  store.applySyncState(theirs);
  assert.equal(changes, 1, 'nothing new the second time');
});

test('applySyncState leaves out what it cannot read from the other device', () => {
  const store = S.createStore(S.memoryStorage());
  store.applySyncState({
    records: [null, { id: 5, artist: 'Can', title: 'Future Days' }, { id: 'no-title', artist: 'Can' }, steelyDan('aja', 'Aja')],
    wishlist: 'not a list',
    confirmed: { 'rg-a': 5, 'rg-b': at(1) },
    deleted: 'not markers',
  });
  store.applySyncState(null);
  assert.deepEqual(titles(store.all()), ['Aja']);
  assert.deepEqual(store.syncState().confirmed, { 'rg-b': at(1) });
});

test('saving a cover color does not count as a change to the record', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at(1)) });
  const storage = S.memoryStorage();
  const store = S.createStore(storage);
  const record = store.add({ artist: 'Steely Dan', title: 'Aja' });
  t.mock.timers.setTime(Date.parse(at(2)));
  store.setCoverColor(record.id, 'rgb(12 34 56)');
  const saved = S.createStore(storage).get(record.id);
  assert.equal(saved.coverColor, 'rgb(12 34 56)');
  assert.equal(saved.updatedAt, at(1));
});

test('two tabs open at once keep both their changes', () => {
  const shared = S.memoryStorage();
  const first = S.createStore(shared);
  const second = S.createStore(shared);
  let shown = 0;
  second.onChange(() => shown++);

  first.setPref('sort', 'year');
  second.reload();
  assert.equal(shown, 0, 'a preference saved in the other tab changes nothing that syncs');

  first.add({ artist: 'Steely Dan', title: 'Aja' });
  second.reload();
  assert.equal(shown, 1, 'the other tab shows the new record');
  second.add({ artist: 'Radiohead', title: 'OK Computer' });
  assert.deepEqual(titles(S.createStore(shared).all()), ['Aja', 'OK Computer']);
});

test('unreadable saved data is set aside instead of overwritten', () => {
  const storage = S.memoryStorage();
  storage.setItem(S.KEYS.records, '{oops');
  const store = S.createStore(storage);
  assert.equal(store.all().length, 0);
  assert.equal(storage.getItem(`${S.KEYS.records}.unreadable`), '{oops');
});

test('a store without storage still works for the visit', () => {
  const store = S.createStore(null);
  assert.equal(store.persistent, false);
  store.add({ artist: 'Can', title: 'Tago Mago' });
  assert.equal(store.all().length, 1);
});

test('a saved discography goes stale after a week and is dropped after four', (t) => {
  const storage = S.memoryStorage();
  const store = S.createStore(storage);
  store.saveDiscography('a1', { name: 'Radiohead', groups: [] });
  assert.equal(store.getDiscography('a1').name, 'Radiohead');
  assert.equal(store.discographyStale(store.getDiscography('a1')), false);
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const clock = t.mock.method(Date, 'now', () => now + 8 * day);
  assert.equal(store.getDiscography('a1').name, 'Radiohead', 'still shown while a new copy loads');
  assert.equal(store.discographyStale(store.getDiscography('a1')), true);
  clock.mock.mockImplementation(() => now + 29 * day);
  assert.equal(store.getDiscography('a1'), null);
  store.saveDiscography('a2', { name: 'Portishead', groups: [] });
  assert.deepEqual(Object.keys(JSON.parse(storage.getItem(S.KEYS.discographies))), ['a2'], 'saving clears out copies older than four weeks');
});

test('saving a discography keeps the time it was fetched, when it has one', () => {
  const store = S.createStore(S.memoryStorage());
  const fetchedAt = Date.now() - 3 * 24 * 60 * 60 * 1000;
  assert.equal(store.saveDiscography('a1', { name: 'Radiohead', groups: [], fetchedAt }).fetchedAt, fetchedAt);
});

test('discographies cached under older rules are cleared', () => {
  const storage = S.memoryStorage();
  for (const v of [1, 2, 3, 4, 5]) storage.setItem(`recordcatalog.discographies.v${v}`, '{"a1":{"groups":[]}}');
  S.createStore(storage);
  for (const v of [1, 2, 3, 4, 5]) assert.equal(storage.getItem(`recordcatalog.discographies.v${v}`), null);
  assert.equal(S.KEYS.discographies, 'recordcatalog.discographies.v6');
});

test('categoryOf sorts release groups into filter buckets', () => {
  assert.equal(S.categoryOf({ primaryType: 'Album', secondaryTypes: [] }), 'album');
  assert.equal(S.categoryOf({ primaryType: 'EP' }), 'ep');
  assert.equal(S.categoryOf({ primaryType: 'Single', secondaryTypes: [] }), 'single');
  assert.equal(S.categoryOf({ primaryType: 'Album', secondaryTypes: ['Live'] }), 'live');
  assert.equal(S.categoryOf({ primaryType: 'Album', secondaryTypes: ['Compilation'] }), 'compilation');
  assert.equal(S.categoryOf({ primaryType: 'Album', secondaryTypes: ['Soundtrack'] }), 'other');
  assert.equal(S.categoryOf({ primaryType: 'Broadcast', secondaryTypes: [] }), 'other');
});

const radiohead = { id: 'a1', name: 'Radiohead' };
const album = (id, title, date, secondaryTypes = []) => ({ id, title, date, primaryType: 'Album', secondaryTypes });

test('compareDiscography matches by release group id, then by title', () => {
  const groups = [
    album('g1', 'Pablo Honey', '1993-02-22'),
    album('g2', 'The Bends', '1995-03-13'),
    album('g3', 'OK Computer', '1997-05-21'),
    album('g4', 'I Might Be Wrong', '2001-11-12', ['Live']),
  ];
  const records = [
    { id: 'r1', artist: 'Radiohead', title: 'OK Computer OKNOTOK', releaseGroupId: 'g3', format: 'LP' },
    { id: 'r2', artist: 'radiohead', title: 'The Bends (Remastered)', format: 'LP' },
    { id: 'r3', artist: 'Radiohead', title: 'Kid A Mnesia', format: 'LP' },
    { id: 'r4', artist: 'Portishead', title: 'Pablo Honey', format: 'LP' },
    { id: 'r5', artist: 'The Other Radiohead', title: 'Pablo Honey', artistId: 'a2', format: 'LP' },
  ];
  const { items, unmatched } = S.compareDiscography(groups, records, radiohead);
  const owned = Object.fromEntries(items.map((item) => [item.group.id, item.records.map((r) => r.id)]));
  assert.deepEqual(owned, { g1: [], g2: ['r2'], g3: ['r1'], g4: [] });
  assert.deepEqual(unmatched.map((r) => r.id), ['r3']);
});

test('a record whose artist id belongs to someone else is not matched by name', () => {
  const groups = [album('g1', 'Bleach', '1989')];
  const records = [{ id: 'r1', artist: 'Nirvana', title: 'Bleach', artistId: 'uk-nirvana' }];
  const { items } = S.compareDiscography(groups, records, { id: 'us-nirvana', name: 'Nirvana' });
  assert.deepEqual(items[0].records, []);
});

test('a 45 goes to the single when an album shares its title', () => {
  const groups = [album('lp', 'Help!', '1965'), { id: 'sg', title: 'Help!', date: '1965', primaryType: 'Single', secondaryTypes: [] }];
  const records = [
    { id: 'r1', artist: 'The Beatles', title: 'Help!', format: '45' },
    { id: 'r2', artist: 'Beatles', title: 'Help!', format: 'LP' },
  ];
  const { items } = S.compareDiscography(groups, records, { id: 'b', name: 'The Beatles' });
  assert.deepEqual(items.map((item) => item.records.map((r) => r.id)), [['r2'], ['r1']]);
});

test('a deluxe edition is its own entry, right after the original', () => {
  const weezer = { id: 'w', name: 'Weezer' };
  const groups = [
    { ...album('blue', 'Weezer', '1994'), vinyl: true },
    { ...album('pink', 'Pinkerton', '1996'), vinyl: true, deluxe: { title: 'Pinkerton (Deluxe Edition)', date: '2010', vinyl: false, releaseIds: ['pink-dlx-cd'] } },
  ];
  const records = [
    { id: 'r1', artist: 'Weezer', title: 'Pinkerton', releaseGroupId: 'pink', format: 'LP' },
    { id: 'r2', artist: 'Weezer', title: 'Pinkerton (Deluxe Edition)', format: 'Double LP' }, // typed in by hand
    { id: 'r3', artist: 'Weezer', title: 'Pinkerton', releaseGroupId: 'pink', releaseId: 'pink-dlx-cd', format: 'CD' }, // added by barcode
    { id: 'r4', artist: 'Weezer', title: 'Weezer (Deluxe Edition)', format: 'LP' }, // no deluxe known for this one
  ];
  const { items } = S.compareDiscography(groups, records, weezer);
  assert.deepEqual(items.map((item) => [item.key, item.title, item.vinyl, item.records.map((r) => r.id)]), [
    ['blue', 'Weezer', true, ['r4']],
    ['pink', 'Pinkerton', true, ['r1']],
    ['pink:deluxe', 'Pinkerton (Deluxe Edition)', false, ['r2', 'r3']],
  ]);
});

test('pickRandom avoids recent picks until it runs out of others', () => {
  const pool = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  for (let i = 0; i < 30; i++) assert.equal(S.pickRandom(pool, ['a', 'b']).id, 'c');
  assert.ok(pool.includes(S.pickRandom(pool, ['a', 'b', 'c'])));
  assert.equal(S.pickRandom(pool, [], () => 0.99).id, 'c');
  assert.equal(S.pickRandom([], []), null);
});

test('readImport reads "Artist - Title" lines, keeps notes and folds repeats', () => {
  const { kind, items, unreadable, merged } = S.readImport([
    'Steely Dan - Aja',
    '  2. Rush – Moving Pictures (Signed)',
    'Bleachers - everyone for ten minutes',
    'Bleachers - everyone for ten minutes (Electric Lady)',
    'T.Rex - Teenage Dream (Single/45)',
    'Weezer - Pinkerton (Deluxe Edition)',
    'Lumineers - BRIGHTSIDE (I have 2)',
    'Glen Campbell\tBy The Time I Get To Phoenix',
    'Glen Campbell - By the Time I Get to Phoenix',
    '',
    'Just a title',
  ].join('\r\n'));
  assert.deepEqual([kind, unreadable], ['list', ['Just a title']]);
  assert.equal(merged, 2);
  const byTitle = Object.fromEntries(items.map((item) => [item.title, item]));
  assert.equal(items.length, 7);
  assert.deepEqual(byTitle.Aja, { artist: 'Steely Dan', title: 'Aja', year: null, notes: '', format: null });
  assert.equal(byTitle['Moving Pictures'].notes, 'Signed', 'numbering and other dashes are fine');
  assert.equal(byTitle['everyone for ten minutes'].notes, 'Electric Lady; 2 copies');
  assert.deepEqual([byTitle['Teenage Dream'].format, byTitle['Teenage Dream'].notes], ['45', ''], 'a note that only names the format is dropped');
  assert.equal(byTitle['Pinkerton (Deluxe Edition)'].notes, '', 'a deluxe edition keeps it in the title');
  assert.equal(byTitle.BRIGHTSIDE.notes, 'I have 2');
  assert.equal(byTitle['By The Time I Get To Phoenix'].notes, '2 copies', 'tab-separated lines work too');
});

test('readImport reads a spreadsheet saved as CSV by the names in its first row', () => {
  const read = S.readImport([
    'Artist,Album,Year,Format,Label,Notes,Price',
    'Steely Dan,Aja,1977,LP,ABC,',
    '"Crosby, Stills & Nash",Crosby Stills & Nash,1969-05-29,Vinyl,Atlantic,"Gatefold, ""first press"""',
    'T. Rex,Teenage Dream,1974,"7""",EMI,"Bought in',
    'London"',
    'Rush,Moving Pictures (Signed),5/29/1981,2xLP,Mercury,VG+',
    'Rush,Moving Pictures,,,,',
    ',No Artist,2000,LP,,',
    ',,,,,',
    'Weezer,Pinkerton (Deluxe Edition),2010,"Box Set, 2xLP",,',
    'Prince,Purple Rain,1984,Cassette,,',
    'Björk,Post,1995,"CD, Single",,',
    'Radiohead,In Rainbows,2007,"2xLP + CD",,',
    'Portishead,Third,2008,Flexi-disc,,',
    '',
  ].join('\r\n'));
  assert.equal(read.kind, 'table');
  assert.deepEqual(read.columns, ['Artist', 'Album', 'Year', 'Format', 'Label', 'Notes']);
  assert.deepEqual(read.ignored, ['Price']);
  assert.deepEqual(read.unreadable, ['No Artist, 2000, LP'], 'a blank row is skipped, a row without an artist is listed');
  assert.deepEqual(read.notVinyl, ['Prince, Purple Rain, 1984, Cassette', 'Björk, Post, 1995, CD, Single'], 'CD and cassette rows are left out');
  assert.equal(read.merged, 1);
  const byTitle = Object.fromEntries(read.items.map((item) => [item.title, item]));
  assert.equal(read.items.length, 7);
  assert.equal(byTitle['In Rainbows'].format, 'Double LP', 'a vinyl record with a CD inside is vinyl');
  assert.equal(byTitle.Third.format, null, 'a format the app has no name for is left to Add as');
  assert.deepEqual(byTitle.Aja, { artist: 'Steely Dan', title: 'Aja', year: 1977, format: 'LP', notes: 'Label: ABC' });
  assert.deepEqual(byTitle['Crosby Stills & Nash'], {
    artist: 'Crosby, Stills & Nash', title: 'Crosby Stills & Nash', year: 1969, format: 'LP', notes: 'Gatefold, "first press"; Label: Atlantic',
  }, 'quoted cells keep their commas and quotes');
  assert.deepEqual([byTitle['Teenage Dream'].format, byTitle['Teenage Dream'].notes], ['45', 'Bought in\nLondon; Label: EMI']);
  assert.deepEqual(byTitle['Moving Pictures'], {
    artist: 'Rush', title: 'Moving Pictures', year: 1981, format: 'Double LP', notes: 'Signed; VG+; Label: Mercury; 2 copies',
  }, 'brackets become notes and repeats fold, as in a typed list');
  assert.deepEqual([byTitle['Pinkerton (Deluxe Edition)'].format, byTitle['Pinkerton (Deluxe Edition)'].year], ['Box set', 2010]);
});

test('readImport keeps label, catalog number and condition columns in the notes', () => {
  const read = S.readImport('Artist,Title,Record Label,Cat. No.,Media Condition,Comments\nRush,2112,Mercury,SRM-1-1079,VG+,Gatefold\nRush,Signals,,,,');
  assert.deepEqual(read.ignored, []);
  assert.deepEqual(read.items.map((item) => item.notes), ['Gatefold; Label: Mercury; Catalog number: SRM-1-1079; Condition: VG+', '']);
  assert.equal(read.app, null);
});

// A Discogs collection export, written from memory and from the columns other projects' parsers read.
// A real export is needed to confirm the columns and the values.
const DISCOGS_EXPORT = [
  'Catalog#,Artist,Title,Label,Format,Rating,Released,release_id,CollectionFolder,Date Added,Collection Media Condition,Collection Sleeve Condition,Collection Notes',
  'AA-1006,Steely Dan,Aja,ABC Records,"LP, Album, Gat",,1977,1234567,Uncategorized,2023-01-05 10:00:00,Very Good Plus (VG+),Very Good (VG),Signed',
  'SRM-1-4013,Rush,Moving Pictures,Anthem,"2xLP, Album, RE, 180",5,2015-03-30,7654321,Uncategorized,2023-01-06 10:00:00,Mint (M),Generic,',
  'DGC-24425,Nirvana (2),Nevermind,DGC,"LP, Album",,1991,1111111,Uncategorized,2023-01-07 10:00:00,,,',
  'KCS 9914,Simon & Garfunkel,Bridge Over Troubled Water,Columbia,"CD, Album",,1970,2222222,Uncategorized,2023-01-08 10:00:00,,,',
].join('\n');

test('readImport reads a Discogs collection export', () => {
  const read = S.readImport(DISCOGS_EXPORT);
  assert.deepEqual([read.kind, read.app], ['table', 'Discogs']);
  assert.deepEqual(read.ignored, ['Rating', 'release_id', 'CollectionFolder', 'Date Added']);
  assert.deepEqual(read.notVinyl, ['KCS 9914, Simon & Garfunkel, Bridge Over Troubled Water, Columbia, CD, Album, 1970, 2222222, Uncategorized, 2023-01-08 10:00:00']);
  assert.deepEqual(read.items, [
    {
      artist: 'Steely Dan', title: 'Aja', year: null, format: 'LP',
      notes: 'Signed; Label: ABC Records; Catalog number: AA-1006; Pressing year: 1977; Media condition: VG+; Sleeve condition: VG',
    },
    {
      artist: 'Rush', title: 'Moving Pictures', year: null, format: 'Double LP',
      notes: 'Label: Anthem; Catalog number: SRM-1-4013; Pressing year: 2015; Media condition: M; Sleeve condition: Generic',
    },
    { artist: 'Nirvana', title: 'Nevermind', year: null, format: 'LP', notes: 'Label: DGC; Catalog number: DGC-24425; Pressing year: 1991' },
  ], 'no year, so MusicBrainz fills in the original one, and the " (2)" Discogs adds to tell artists apart is gone');
});

test('readImport reads TSV and semicolon CSV, and lines without column names as a typed list', () => {
  const tsv = S.readImport('Band\tTitle\tMedia\nPortishead\tDummy\t12"\n');
  assert.equal(tsv.kind, 'table');
  assert.deepEqual(tsv.items, [{ artist: 'Portishead', title: 'Dummy', year: null, format: 'LP', notes: '' }]);
  const semicolons = S.readImport('artist;title;released\nBjörk;Debut;1993');
  assert.deepEqual(semicolons.items, [{ artist: 'Björk', title: 'Debut', year: 1993, format: null, notes: '' }]);
  const pasted = S.readImport('Artist\tTitle\nSteely Dan\tAja');
  assert.deepEqual(pasted.items.map((item) => item.title), ['Aja'], 'a pasted header row is not a record');

  assert.equal(S.readImport('Steely Dan - Aja\nRush - 2112').kind, 'list');
  assert.equal(S.readImport('Steely Dan\tAja').kind, 'list', 'two pasted columns without names');
  const commas = S.readImport('Earth, Wind & Fire - Spirit\nCrosby, Stills & Nash - CSN');
  assert.deepEqual([commas.kind, commas.items.length], ['list', 2], 'commas in a typed list are not columns');
  assert.equal(S.readImport('').kind, 'list');
});

const candidate = (title, extra = {}) => ({
  releaseGroupId: extra.id || title, title, artist: 'Weezer', artistId: 'w', year: 2001, primaryType: 'Album', secondaryTypes: [], ...extra,
});

test('bestAlbumMatch forgives typos but not different numbers', () => {
  const found = [candidate('Maladroit'), candidate('Make Believe')];
  assert.equal(S.bestAlbumMatch({ artist: 'Weezer', title: 'Maladriot' }, found).title, 'Maladroit');
  assert.equal(S.bestAlbumMatch({ artist: 'Weeser', title: 'Maladroit' }, found).renameArtist, true, 'a misspelled artist takes the MusicBrainz spelling');
  assert.equal(S.bestAlbumMatch({ artist: 'Weezer', title: 'Pinkerton' }, found), null);
  assert.equal(S.bestAlbumMatch({ artist: 'Toto', title: 'Toto' }, [candidate('Toto IV', { artist: 'Toto' })]), null);
  assert.equal(S.bestAlbumMatch({ artist: 'Moody Blues', title: 'Octave' }, [candidate('Octave', { artist: 'The Moody Blues' })]).renameArtist, true);
  const prince = candidate('Purple Rain', { artist: 'Prince and The Revolution', secondaryTypes: ['Soundtrack'] });
  assert.equal(S.bestAlbumMatch({ artist: 'Prince', title: 'Purple Rain' }, [prince]).renameArtist, false, 'a longer credit keeps your spelling');
});

test('bestAlbumMatch prefers albums, and gives up when it is too close to call', () => {
  const single = candidate('Buddy Holly', { id: 'single', primaryType: 'Single' });
  const album = candidate('Buddy Holly', { id: 'album' });
  assert.equal(S.bestAlbumMatch({ artist: 'Weezer', title: 'Buddy Holly' }, [single, album]).releaseGroupId, 'album');
  assert.equal(S.bestAlbumMatch({ artist: 'Weezer', title: 'Buddy Holly', format: '45' }, [single, album]).releaseGroupId, 'single', 'a 45 is a single');
  assert.equal(S.bestAlbumMatch({ artist: 'Weezer', title: 'Weezer' }, [candidate('Weezer', { id: 'blue' }), candidate('Weezer', { id: 'green' })]), null);
  const live = candidate("Get Yer Ya-Ya's Out! The Rolling Stones in Concert", { id: 'live', secondaryTypes: ['Live'] });
  const ep = candidate("Get Yer Ya-Ya's Out", { id: 'ep', primaryType: 'EP' });
  assert.equal(S.bestAlbumMatch({ artist: 'Weezer', title: "Get Yer Ya-Ya's Out!" }, [ep, live]).releaseGroupId, 'live', 'a subtitle can pick the album');
  assert.equal(S.bestAlbumMatch({ artist: 'Weezer', title: 'Chicago II' }, [candidate('Chicago II: Live on Soundstage', { secondaryTypes: ['Live'] })]), null,
    'but a live album found only by its subtitle is not enough');
  assert.equal(S.bestAlbumMatch({ artist: 'Weezer', title: 'Labyrinth' }, [candidate('Labyrinth: From the Original Soundtrack', { secondaryTypes: ['Soundtrack'] })]).title,
    'Labyrinth: From the Original Soundtrack');
  assert.equal(S.bestAlbumMatch({ artist: 'Masayoshi Takanaka', title: 'Seychelles' }, [candidate('SEYCHELLES', { artist: '高中正義', artistFound: true })]).renameArtist, false,
    'an artist found by alias keeps your spelling');
});

test('addMany adds several records at once and removeMany takes them back', () => {
  const store = S.createStore(S.memoryStorage());
  store.add({ artist: 'Steely Dan', title: 'Aja' });
  store.addToWishlist({ artist: 'Rush', title: '2112' });
  let changes = 0;
  store.onChange(() => changes++);
  const { added, skipped } = store.addMany([
    { artist: 'Steely Dan', title: 'aja' },
    { artist: 'Rush', title: '2112', pendingLookup: true },
    { artist: 'Rush', title: 'Moving Pictures', pendingLookup: true },
    { artist: '', title: 'No artist' },
    { artist: 'rush', title: 'moving pictures' },
  ]);
  assert.equal(added.length, 2);
  assert.equal(skipped.length, 3, 'including a second copy of an album added a moment ago');
  assert.equal(changes, 1, 'one save for the lot');
  assert.equal(store.wishlist().length, 0, 'owning it takes it off the wishlist');
  assert.equal(store.get(added[0].id).pendingLookup, true);
  store.removeMany(added.map((record) => record.id));
  assert.deepEqual(store.all().map((record) => record.title), ['Aja']);
});

test('notInCollection keeps the albums you do not have yet, by the same rules as findCopy', () => {
  const store = S.createStore(S.memoryStorage());
  store.add({ artist: 'Radiohead', title: 'OK Computer', releaseGroupId: 'rg-okc' });
  store.add({ artist: 'Weezer', title: 'Weezer' });
  store.add({ artist: 'Bleachers', title: 'Strange Desire', releaseGroupId: 'rg-strange' });
  store.add({ artist: 'Weezer', title: 'Pinkerton (Deluxe Edition)' });
  const inputs = [
    { artist: 'radiohead', title: 'ok computer' },
    { artist: 'Radiohead', title: 'OKC', releaseGroupId: 'rg-okc' },
    { artist: 'Weezer', title: 'Weezer', releaseGroupId: 'rg-blue' },
    { artist: 'Bleachers', title: 'Strange Desire', releaseGroupId: 'rg-other' },
    { artist: 'Weezer', title: 'Pinkerton' },
    { artist: 'The Weezer', title: 'Pinkerton (Deluxe)' },
    { artist: 'Bleachers', title: 'Strange Desire (Deluxe)', releaseGroupId: 'rg-strange' },
  ];
  const fresh = store.notInCollection(inputs);
  assert.deepEqual(fresh.map((input) => input.title), ['Strange Desire', 'Pinkerton', 'Strange Desire (Deluxe)'],
    'a typed name matches a linked record, release groups decide between linked ones, and editions never match');
  assert.deepEqual(fresh, inputs.filter((input) => !store.findCopy(input)));
});

test('checking 1,000 imported records against 1,000 owned ones stays fast', (t) => {
  const collection = () => {
    const store = S.createStore(S.memoryStorage());
    store.addMany(Array.from({ length: 1000 }, (_, i) => ({ artist: `Owned ${i}`, title: `Album ${i}`, releaseGroupId: i % 2 ? `rg-${i}` : null })));
    return store;
  };
  const inputs = Array.from({ length: 1000 }, (_, i) => (i % 10 ? { artist: `New ${i}`, title: `Album ${i}` } : { artist: `owned ${i}`, title: `album ${i}` }));
  const source = S.createStore(S.memoryStorage());
  source.addMany(inputs);
  const backup = S.readImport(source.exportJSON());
  const timed = (run) => {
    const store = collection();
    const start = process.hrtime.bigint();
    const result = run(store);
    return [result, Number(process.hrtime.bigint() - start) / 1e6];
  };

  const [fresh, preview] = timed((store) => store.notInCollection(inputs));
  const [{ added }, adding] = timed((store) => store.addMany(inputs));
  const [merged, merging] = timed((store) => store.importBackup(backup));
  t.diagnostic(`notInCollection ${preview.toFixed(1)} ms, addMany ${adding.toFixed(1)} ms, importBackup ${merging.toFixed(1)} ms`);
  assert.deepEqual([fresh.length, added.length, merged.added], [900, 900, 900]);
  for (const [name, took] of [['notInCollection', preview], ['addMany', adding], ['importBackup', merging]]) {
    assert.ok(took < 250, `${name} took ${took.toFixed(0)} ms, where comparing every pair took over a second`);
  }
});

test('changing the artist name drops the old MusicBrainz artist link', () => {
  const store = S.createStore(S.memoryStorage());
  const record = store.add({ artist: 'Little Feet', title: 'Time Loves a Hero', artistId: 'wrong' });
  assert.equal(store.update(record.id, { notes: 'Signed' }).artistId, 'wrong');
  assert.equal(store.update(record.id, { artist: 'Little Feat' }).artistId, null);
  assert.equal(store.update(record.id, { artist: 'Little Feet', artistId: 'lf' }).artistId, 'lf');
});
