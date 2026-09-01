'use strict';
/**
 * Analisis otomatis untuk dashboard.
 *
 * Semua temuan di sini dihitung dengan aturan yang eksplisit dari data yang
 * ada di database — bukan tebakan model bahasa. Setiap temuan membawa `dasar`
 * yang menjelaskan angka pembentuknya, supaya bisa diperiksa ulang dan tidak
 * perlu dipercaya begitu saja.
 */
const { db } = require('../db');
const { r2 } = require('./accounting');
const STATUS = require('./status-pesanan');

const rp = (n) => 'Rp ' + Math.round(n).toLocaleString('id-ID');

/**
 * Produk yang akan habis, dihitung dari laju penjualan nyata.
 * Laju = total qty terjual dalam N hari terakhir ÷ N.
 */
function stokAkanHabis(hariAnalisis = 30, ambangHari = 14) {
  const rows = db
    .prepare(
      `SELECT p.id, p.sku, p.name, p.unit, p.stock, p.cost,
              COALESCE(SUM(i.qty), 0) AS terjual
         FROM products p
         LEFT JOIN sales_items i ON i.product_id = p.id
         LEFT JOIN sales_orders o ON o.id = i.order_id
              AND o.status = 'POSTED'
              AND o.order_date >= date('now', ?)
        WHERE p.active = 1 AND p.stock > 0
        GROUP BY p.id
       HAVING terjual > 0`
    )
    .all(`-${hariAnalisis} days`);

  return rows
    .map((p) => {
      const lajuHarian = p.terjual / hariAnalisis;
      const sisaHari = lajuHarian > 0 ? p.stock / lajuHarian : Infinity;
      return { ...p, lajuHarian: r2(lajuHarian), sisaHari: Math.floor(sisaHari) };
    })
    .filter((p) => p.sisaHari <= ambangHari)
    .sort((a, b) => a.sisaHari - b.sisaHari);
}

/** Modal yang mengendap: ada stok bernilai, tetapi tidak laku sekian lama. */
function stokMati(hariDiam = 60, minNilai = 100000) {
  return db
    .prepare(
      `SELECT p.id, p.sku, p.name, p.unit, p.stock, p.cost,
              (p.stock * p.cost) AS nilai,
              (SELECT MAX(o.order_date)
                 FROM sales_items i JOIN sales_orders o ON o.id = i.order_id
                WHERE i.product_id = p.id AND o.status = 'POSTED') AS terakhir_terjual
         FROM products p
        WHERE p.active = 1 AND p.stock > 0 AND (p.stock * p.cost) >= ?
          AND (
            (SELECT MAX(o.order_date)
               FROM sales_items i JOIN sales_orders o ON o.id = i.order_id
              WHERE i.product_id = p.id AND o.status = 'POSTED') IS NULL
            OR (SELECT MAX(o.order_date)
                  FROM sales_items i JOIN sales_orders o ON o.id = i.order_id
                 WHERE i.product_id = p.id AND o.status = 'POSTED') < date('now', ?)
          )
        ORDER BY nilai DESC
        LIMIT 20`
    )
    .all(minNilai, `-${hariDiam} days`)
    .map((p) => ({ ...p, nilai: r2(p.nilai) }));
}

/** Perbandingan margin antar toko pada satu periode. */
function performaToko(from, to) {
  return db
    .prepare(
      `SELECT s.id, s.name, s.channel,
              COUNT(o.id)                     AS orders,
              COALESCE(SUM(o.net_revenue), 0) AS net_revenue,
              COALESCE(SUM(o.total_fees), 0)  AS total_fees,
              COALESCE(SUM(o.net_profit), 0)  AS net_profit
         FROM shops s
         JOIN sales_orders o ON o.shop_id = s.id
              AND o.status = 'POSTED' AND o.order_date BETWEEN ? AND ?
        GROUP BY s.id
        ORDER BY net_profit DESC`
    )
    .all(from, to)
    .map((s) => ({
      ...s,
      net_revenue: r2(s.net_revenue),
      total_fees: r2(s.total_fees),
      net_profit: r2(s.net_profit),
      margin_pct: s.net_revenue ? r2((s.net_profit / s.net_revenue) * 100) : 0,
      fee_ratio_pct: s.net_revenue ? r2((s.total_fees / s.net_revenue) * 100) : 0,
    }));
}

/** Dana marketplace yang belum cair. */
function danaTertahan() {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(net_revenue - total_fees), 0) AS nilai
         FROM sales_orders
        WHERE status = 'POSTED'
          AND fulfillment_status IN (${STATUS.sqlIn(STATUS.BERJALAN)})`
    )
    .get(...STATUS.BERJALAN);
  return { orders: row.orders, nilai: r2(row.nilai) };
}

/** Selisih ongkir yang akhirnya ditanggung penjual. */
function bebanOngkir(from, to) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(shipping_charged), 0) AS ditagih,
              COALESCE(SUM(shipping_extra), 0)   AS ditanggung,
              COUNT(*) AS orders
         FROM sales_orders
        WHERE status = 'POSTED' AND order_date BETWEEN ? AND ?`
    )
    .get(from, to);
  return {
    ditagih: r2(row.ditagih),
    ditanggung: r2(row.ditanggung),
    orders: row.orders,
  };
}

/** Kota penyumbang omzet terbesar. */
function kotaTeratas(from, to, limit = 8) {
  return db
    .prepare(
      `SELECT COALESCE(NULLIF(TRIM(buyer_city), ''), '(tidak dicatat)') AS kota,
              COUNT(*) AS orders,
              COALESCE(SUM(net_revenue), 0) AS net_revenue,
              COALESCE(SUM(net_profit), 0)  AS net_profit
         FROM sales_orders
        WHERE status = 'POSTED' AND order_date BETWEEN ? AND ?
        GROUP BY kota
        ORDER BY net_revenue DESC
        LIMIT ?`
    )
    .all(from, to, limit)
    .map((k) => ({ ...k, net_revenue: r2(k.net_revenue), net_profit: r2(k.net_profit) }));
}

/** Ekspedisi yang paling sering dipakai. */
function ekspedisiTeratas(from, to, limit = 8) {
  return db
    .prepare(
      `SELECT COALESCE(NULLIF(TRIM(courier), ''), '(tidak dicatat)') AS ekspedisi,
              COUNT(*) AS orders,
              COALESCE(SUM(shipping_extra), 0) AS beban
         FROM sales_orders
        WHERE status = 'POSTED' AND order_date BETWEEN ? AND ?
        GROUP BY ekspedisi
        ORDER BY orders DESC
        LIMIT ?`
    )
    .all(from, to, limit)
    .map((e) => ({ ...e, beban: r2(e.beban) }));
}

/** Karyawan dengan keterlambatan terbanyak pada periode. */
function seringTerlambat(from, to, minimal = 3) {
  return db
    .prepare(
      `SELECT u.name,
              SUM(CASE WHEN a.status = 'LATE' THEN 1 ELSE 0 END) AS telat,
              COUNT(*) AS hadir,
              COALESCE(SUM(a.late_minutes), 0) AS total_menit
         FROM attendance a JOIN users u ON u.id = a.user_id
        WHERE a.work_date BETWEEN ? AND ?
        GROUP BY u.id
       HAVING telat >= ?
        ORDER BY telat DESC, total_menit DESC
        LIMIT 5`
    )
    .all(from, to, minimal);
}

/**
 * Menyusun temuan yang layak ditindak. Tiap temuan menyebutkan dasarnya
 * supaya bisa diverifikasi, bukan sekadar disodorkan sebagai kesimpulan.
 */
function susunTemuan({ from, to, toko, akanHabis, mati, tertahan, ongkir, telat, ringkasPenjualan }) {
  const temuan = [];

  // Sebagian analisis membandingkan stok terhadap riwayat penjualan. Bila
  // riwayatnya belum ada, temuannya akan benar secara teknis tapi menyesatkan
  // — semua produk akan tampak "tidak laku" padahal memang belum ada transaksi.
  const adaRiwayatJual = db
    .prepare("SELECT COUNT(*) c FROM sales_orders WHERE status = 'POSTED'")
    .get().c > 0;

  if (!adaRiwayatJual) {
    temuan.push({
      jenis: 'penjualan',
      tingkat: 'info',
      judul: 'Belum ada penjualan tercatat',
      pesan: 'Analisis pergerakan stok dan perbandingan toko baru bisa dihitung setelah ada order yang masuk.',
      dasar: 'jumlah order berstatus POSTED',
      aksi: 'Mulai catat order lewat menu Order Penjualan — analisis akan terisi sendiri.',
    });
  }

  // --- Stok kritis ---
  const kritis = akanHabis.filter((p) => p.sisaHari <= 7);
  if (kritis.length) {
    const contoh = kritis.slice(0, 3).map((p) => `${p.name} (${p.sisaHari} hari)`).join(', ');
    temuan.push({
      jenis: 'stok',
      tingkat: 'mendesak',
      judul: `${kritis.length} produk habis dalam 7 hari`,
      pesan: `Berdasarkan laju penjualan 30 hari terakhir: ${contoh}.`,
      dasar: 'stok saat ini ÷ rata-rata terjual per hari',
      aksi: 'Segera pesan ke supplier — kehabisan di marketplace menurunkan peringkat toko.',
    });
  }

  // --- Modal mengendap ---
  if (adaRiwayatJual && mati.length) {
    const nilai = mati.reduce((s, p) => s + p.nilai, 0);
    temuan.push({
      jenis: 'stok',
      tingkat: 'perhatian',
      judul: `${rp(nilai)} modal mengendap di ${mati.length} produk`,
      pesan: `Produk ini punya stok bernilai tapi tidak terjual sama sekali dalam 60 hari terakhir. Terbesar: ${mati[0].name} (${rp(mati[0].nilai)}).`,
      dasar: 'nilai persediaan × tanpa penjualan 60 hari',
      aksi: 'Pertimbangkan diskon, bundling, atau iklan khusus agar modal berputar.',
    });
  }

  // --- Dana tertahan ---
  if (tertahan.orders > 0) {
    temuan.push({
      jenis: 'keuangan',
      tingkat: tertahan.nilai > 10_000_000 ? 'perhatian' : 'info',
      judul: `${rp(tertahan.nilai)} belum cair dari marketplace`,
      pesan: `${tertahan.orders} order berstatus Diproses/Dikirim/Selesai tapi belum ditandai Cair.`,
      dasar: '(pendapatan bersih − biaya) pada order yang belum berstatus Cair',
      aksi: 'Cocokkan dengan mutasi rekening, lalu tandai Cair agar arus kas akurat.',
    });
  }

  // --- Selisih toko terbaik vs terburuk ---
  if (toko.length >= 2) {
    const untung = toko.filter((t) => t.orders >= 3);
    if (untung.length >= 2) {
      const terbaik = untung[0];
      const terburuk = untung[untung.length - 1];
      const selisih = r2(terbaik.margin_pct - terburuk.margin_pct);
      if (selisih >= 10) {
        temuan.push({
          jenis: 'penjualan',
          tingkat: 'peluang',
          judul: `Margin ${terbaik.name} unggul ${selisih}% atas ${terburuk.name}`,
          pesan: `${terbaik.name}: margin ${terbaik.margin_pct}%, beban channel ${terbaik.fee_ratio_pct}%. ` +
            `${terburuk.name}: margin ${terburuk.margin_pct}%, beban channel ${terburuk.fee_ratio_pct}%.`,
          dasar: 'perbandingan margin & rasio biaya antar toko pada periode yang sama',
          aksi: `Tinjau harga, voucher, dan iklan di ${terburuk.name} — atau alihkan stok ke toko yang lebih untung.`,
        });
      }
    }

    const rugi = toko.filter((t) => t.net_profit < 0);
    if (rugi.length) {
      temuan.push({
        jenis: 'penjualan',
        tingkat: 'mendesak',
        judul: `${rugi.length} toko merugi pada periode ini`,
        pesan: rugi.map((t) => `${t.name} ${rp(t.net_profit)}`).join(', ') + '.',
        dasar: 'laba bersih setelah HPP dan seluruh biaya channel',
        aksi: 'Periksa voucher dan ongkir yang ditanggung — biasanya dua itu penyebabnya.',
      });
    }
  }

  // --- Ongkir ---
  if (ongkir.ditanggung > 0) {
    const persen = ringkasPenjualan.netRevenue
      ? r2((ongkir.ditanggung / ringkasPenjualan.netRevenue) * 100)
      : 0;
    if (persen >= 3) {
      temuan.push({
        jenis: 'penjualan',
        tingkat: 'perhatian',
        judul: `Ongkir menggerus ${persen}% pendapatan`,
        pesan: `${rp(ongkir.ditanggung)} ongkir ditanggung penjual, sementara ${rp(ongkir.ditagih)} ditagih ke pembeli.`,
        dasar: 'ongkir ditanggung ÷ pendapatan bersih',
        aksi: 'Naikkan minimum gratis ongkir, atau masukkan sebagian ongkir ke harga jual.',
      });
    }
  }

  // --- Presensi ---
  if (telat.length) {
    const t = telat[0];
    temuan.push({
      jenis: 'presensi',
      tingkat: 'info',
      judul: `${telat.length} karyawan sering terlambat`,
      pesan: `Terbanyak ${t.name}: ${t.telat} kali dari ${t.hadir} kehadiran (${t.total_menit} menit).`,
      dasar: 'jumlah presensi berstatus Terlambat pada periode',
      aksi: 'Bicarakan langsung sebelum jadi kebiasaan; cek juga apakah jam masuk sudah realistis.',
    });
  }

  // --- Margin tipis ---
  if (ringkasPenjualan.netRevenue > 0 && ringkasPenjualan.marginPct < 10) {
    temuan.push({
      jenis: 'keuangan',
      tingkat: 'mendesak',
      judul: `Margin bersih hanya ${ringkasPenjualan.marginPct}%`,
      pesan: `Dari ${rp(ringkasPenjualan.netRevenue)} pendapatan, ${rp(ringkasPenjualan.totalFees)} habis untuk biaya channel.`,
      dasar: 'laba bersih ÷ pendapatan bersih pada periode',
      aksi: 'Margin di bawah 10% rawan — satu kenaikan biaya admin bisa membuat rugi.',
    });
  }

  const urutan = { mendesak: 0, perhatian: 1, peluang: 2, info: 3 };
  return temuan.sort((a, b) => urutan[a.tingkat] - urutan[b.tingkat]);
}

module.exports = {
  stokAkanHabis,
  stokMati,
  performaToko,
  danaTertahan,
  bebanOngkir,
  kotaTeratas,
  ekspedisiTeratas,
  seringTerlambat,
  susunTemuan,
};
