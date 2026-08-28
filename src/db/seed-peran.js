'use strict';
/**
 * Menyiapkan peran bawaan dan menautkan akun yang sudah ada.
 *
 * Dijalankan tiap boot dan bersifat menambah saja.
 *
 * Masalah yang diselesaikan di sini: setiap kali menu baru dipasang, izinnya
 * ikut bertambah di daftar bawaan. Kalau peran yang sudah ada tidak pernah
 * disentuh lagi, menu barunya tidak terlihat oleh siapa pun kecuali admin —
 * dan tidak ada tanda apa pun bahwa ada yang perlu dinyalakan. Tetapi menimpa
 * izinnya begitu saja juga salah: penyesuaian yang dibuat pemilik akan hilang
 * diam-diam pada restart berikutnya.
 *
 * Jalan tengahnya: izin bawaan yang dipakai saat menyemai direkam pada perannya.
 * Bila izin sebuah peran masih sama persis dengan rekaman itu — berarti belum
 * pernah disesuaikan — ia disegarkan mengikuti daftar bawaan terbaru. Bila sudah
 * berbeda, isinya dibiarkan utuh dan hanya dilaporkan.
 */
const { PERAN_BAWAAN, SEMUA_IZIN, PETA_PERAN_LAMA } = require('../utils/izin');

const samaPersis = (a, b) => {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

function seedPeran(db) {
  const catatan = [];

  const cariSlug = db.prepare('SELECT id, is_system, seeded_json FROM roles WHERE slug = ?');
  const buatPeran = db.prepare(
    'INSERT INTO roles (slug, name, description, is_system, active, seeded_json) VALUES (?,?,?,1,1,?)'
  );
  const pasangIzin = db.prepare(
    'INSERT INTO role_permissions (role_id, permission) VALUES (?,?) ON CONFLICT DO NOTHING'
  );
  const izinPeran = db.prepare('SELECT permission FROM role_permissions WHERE role_id = ?');

  db.transaction(() => {
    for (const p of PERAN_BAWAAN) {
      const ada = cariSlug.get(p.slug);

      if (!ada) {
        const info = buatPeran.run(p.slug, p.name, p.description, JSON.stringify(p.izin));
        for (const izin of p.izin) pasangIzin.run(info.lastInsertRowid, izin);
        catatan.push(`peran ${p.slug}`);
        continue;
      }

      const punya = izinPeran.all(ada.id).map((r) => r.permission);

      // Admin selalu memegang seluruh izin, termasuk yang baru ditambahkan.
      // Kalau tidak, memasang menu baru justru mengunci pemiliknya sendiri
      // keluar dari fitur yang baru saja dipasang.
      if (p.slug === 'admin') {
        const kurang = SEMUA_IZIN.filter((k) => !punya.includes(k));
        for (const izin of kurang) pasangIzin.run(ada.id, izin);
        if (kurang.length) catatan.push(`admin +${kurang.length} izin baru`);
        db.prepare('UPDATE roles SET seeded_json = ? WHERE id = ?').run(JSON.stringify(SEMUA_IZIN), ada.id);
        continue;
      }

      // Peran yang dibuat sebelum rekaman ini ada. Tidak ada acuan untuk tahu
      // apakah ia sudah disesuaikan, jadi keputusannya diambil dari bentuknya:
      // bila seluruh izinnya masih termasuk daftar bawaan, yang kurang saja
      // yang ditambahkan — tidak ada yang dicabut. Bila ia memegang izin di
      // luar daftar bawaan, berarti pernah disusun sendiri dan dibiarkan utuh.
      if (!ada.seeded_json) {
        const punyaTambahan = punya.some((k) => !p.izin.includes(k));
        if (punyaTambahan) {
          db.prepare('UPDATE roles SET seeded_json = ? WHERE id = ?').run(JSON.stringify(punya), ada.id);
          catatan.push(`peran ${p.slug} tampak disusun sendiri — izin bawaan baru tidak dipasang`);
          continue;
        }
        const kurang = p.izin.filter((k) => !punya.includes(k));
        for (const izin of kurang) pasangIzin.run(ada.id, izin);
        db.prepare('UPDATE roles SET seeded_json = ? WHERE id = ?').run(JSON.stringify(p.izin), ada.id);
        if (kurang.length) catatan.push(`peran ${p.slug} +${kurang.length} izin bawaan baru`);
        continue;
      }

      const bawaanLama = JSON.parse(ada.seeded_json);
      if (!samaPersis(punya, bawaanLama)) {
        // Sudah disesuaikan pemiliknya — jangan disentuh.
        const kurang = p.izin.filter((k) => !punya.includes(k));
        if (kurang.length) {
          catatan.push(`peran ${p.slug} disesuaikan sendiri; ${kurang.length} izin bawaan baru dilewati`);
        }
        continue;
      }

      // Masih apa adanya — segarkan mengikuti daftar bawaan terbaru.
      const kurang = p.izin.filter((k) => !punya.includes(k));
      const lebih = punya.filter((k) => !p.izin.includes(k));
      if (kurang.length || lebih.length) {
        db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(ada.id);
        for (const izin of p.izin) pasangIzin.run(ada.id, izin);
        catatan.push(`peran ${p.slug} disegarkan (+${kurang.length}/−${lebih.length})`);
      }
      db.prepare('UPDATE roles SET seeded_json = ? WHERE id = ?').run(JSON.stringify(p.izin), ada.id);
    }

    // Akun yang belum punya peran baru ditautkan dari kolom role lama.
    const belum = db.prepare('SELECT id, role FROM users WHERE role_id IS NULL').all();
    if (belum.length) {
      const idPeran = new Map(
        db.prepare('SELECT id, slug FROM roles').all().map((r) => [r.slug, r.id])
      );
      const set = db.prepare('UPDATE users SET role_id = ? WHERE id = ?');
      let tertaut = 0;
      for (const u of belum) {
        const slug = PETA_PERAN_LAMA[u.role] || 'cs_marketplace';
        const rid = idPeran.get(slug);
        if (rid) {
          set.run(rid, u.id);
          tertaut += 1;
        }
      }
      if (tertaut) catatan.push(`${tertaut} akun ditautkan ke peran`);
    }
  })();

  return catatan;
}

module.exports = { seedPeran };
