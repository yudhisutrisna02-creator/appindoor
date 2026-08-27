'use strict';
/**
 * Menyiapkan peran bawaan dan menautkan akun yang sudah ada.
 *
 * Dijalankan tiap boot dan bersifat menambah saja. Peran yang sudah pernah
 * disesuaikan pemiliknya tidak ditimpa — kalau daftar izinnya ditulis ulang
 * setiap kali server hidup, penyesuaian apa pun akan hilang diam-diam pada
 * restart berikutnya.
 *
 * Satu perkecualian: peran Admin selalu disamakan dengan seluruh katalog izin.
 * Menu baru harus langsung terjangkau admin; kalau tidak, penambahan menu justru
 * mengunci pemiliknya sendiri keluar dari fitur yang baru saja dipasang.
 */
const { PERAN_BAWAAN, SEMUA_IZIN, PETA_PERAN_LAMA } = require('../utils/izin');

function seedPeran(db) {
  const catatan = [];

  const cariSlug = db.prepare('SELECT id, is_system FROM roles WHERE slug = ?');
  const buatPeran = db.prepare(
    'INSERT INTO roles (slug, name, description, is_system, active) VALUES (?,?,?,1,1)'
  );
  const pasangIzin = db.prepare(
    'INSERT INTO role_permissions (role_id, permission) VALUES (?,?) ON CONFLICT DO NOTHING'
  );

  db.transaction(() => {
    for (const p of PERAN_BAWAAN) {
      const ada = cariSlug.get(p.slug);
      if (!ada) {
        const info = buatPeran.run(p.slug, p.name, p.description);
        for (const izin of p.izin) pasangIzin.run(info.lastInsertRowid, izin);
        catatan.push(`peran ${p.slug}`);
        continue;
      }

      if (p.slug === 'admin') {
        // Admin selalu memegang seluruh izin, termasuk yang baru ditambahkan.
        const punya = db
          .prepare('SELECT permission FROM role_permissions WHERE role_id = ?')
          .all(ada.id)
          .map((r) => r.permission);
        const kurang = SEMUA_IZIN.filter((k) => !punya.includes(k));
        for (const izin of kurang) pasangIzin.run(ada.id, izin);
        if (kurang.length) catatan.push(`admin +${kurang.length} izin baru`);
      }
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
