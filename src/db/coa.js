'use strict';

/**
 * Chart of Accounts standar untuk UMKM dagang multi-channel.
 *
 * Kolom:
 *  code, name, type, subtype, normal (D/K), cashflow (OCF/ICF/FCF/NONE), is_cash
 *
 * `cashflow` dipakai Laporan Arus Kas metode tidak langsung/langsung: setiap
 * mutasi pada akun KAS diklasifikasikan mengikuti akun lawannya pada jurnal
 * yang sama.
 */
const COA = [
  // ---------- ASET ----------
  ['1000', 'Kas Tunai',                      'ASSET', 'CASH',            'D', 'OCF',  1],
  ['1010', 'Bank Operasional',               'ASSET', 'CASH',            'D', 'OCF',  1],
  ['1020', 'E-Wallet / QRIS',                'ASSET', 'CASH',            'D', 'OCF',  1],
  ['1100', 'Piutang Usaha',                  'ASSET', 'RECEIVABLE',      'D', 'OCF',  0],
  ['1110', 'Piutang Marketplace (Dana Ditahan)', 'ASSET', 'RECEIVABLE',  'D', 'OCF',  0],
  ['1200', 'Persediaan Barang Dagang',       'ASSET', 'INVENTORY',       'D', 'OCF',  0],
  ['1300', 'Biaya Dibayar di Muka',          'ASSET', 'OTHER_CURRENT',   'D', 'OCF',  0],
  ['1500', 'Peralatan & Inventaris',         'ASSET', 'FIXED_ASSET',     'D', 'ICF',  0],
  ['1510', 'Kendaraan',                      'ASSET', 'FIXED_ASSET',     'D', 'ICF',  0],
  ['1590', 'Akumulasi Penyusutan',           'ASSET', 'ACC_DEPRECIATION','K', 'NONE', 0],

  // ---------- KEWAJIBAN ----------
  ['2000', 'Utang Usaha (Supplier)',         'LIABILITY', 'PAYABLE', 'K', 'OCF', 0],
  ['2100', 'Utang Biaya Operasional',        'LIABILITY', 'ACCRUED', 'K', 'OCF', 0],
  ['2200', 'Utang Pajak',                    'LIABILITY', 'TAX',     'K', 'OCF', 0],
  ['2500', 'Utang Bank / Pinjaman',          'LIABILITY', 'LOAN',    'K', 'FCF', 0],

  // ---------- EKUITAS ----------
  ['3000', 'Modal Pemilik',                  'EQUITY', 'CAPITAL',  'K', 'FCF',  0],
  ['3100', 'Prive (Penarikan Pemilik)',      'EQUITY', 'DRAWING',  'D', 'FCF',  0],
  ['3900', 'Laba Ditahan',                   'EQUITY', 'RETAINED', 'K', 'NONE', 0],

  // ---------- PENDAPATAN ----------
  ['4000', 'Penjualan',                      'REVENUE', 'SALES',          'K', 'OCF', 0],
  ['4100', 'Retur Penjualan',                'REVENUE', 'SALES_RETURN',   'D', 'OCF', 0],
  ['4200', 'Diskon Penjualan',               'REVENUE', 'SALES_DISCOUNT', 'D', 'OCF', 0],
  ['4900', 'Pendapatan Lain-lain',           'REVENUE', 'OTHER_INCOME',   'K', 'OCF', 0],

  // ---------- HARGA POKOK ----------
  ['5000', 'Harga Pokok Penjualan (HPP)',    'EXPENSE', 'COGS', 'D', 'OCF', 0],

  // ---------- BIAYA PENJUALAN / CHANNEL ----------
  ['6000', 'Biaya Admin Marketplace',        'EXPENSE', 'SELLING', 'D', 'OCF', 0],
  ['6010', 'Biaya Handling / Layanan',       'EXPENSE', 'SELLING', 'D', 'OCF', 0],
  ['6020', 'Ongkir Ditanggung Penjual',      'EXPENSE', 'SELLING', 'D', 'OCF', 0],
  ['6030', 'Voucher & Promo Platform',       'EXPENSE', 'SELLING', 'D', 'OCF', 0],
  ['6040', 'Biaya Packing & Operasional Kirim', 'EXPENSE', 'SELLING', 'D', 'OCF', 0],
  ['6050', 'Biaya Iklan & Pemasaran',        'EXPENSE', 'SELLING', 'D', 'OCF', 0],

  // ---------- BIAYA ADMINISTRASI & UMUM ----------
  ['6100', 'Beban Gaji & Tunjangan',         'EXPENSE', 'ADMIN', 'D', 'OCF', 0],
  ['6110', 'Beban Sewa Tempat',              'EXPENSE', 'ADMIN', 'D', 'OCF', 0],
  ['6120', 'Beban Listrik, Air & Internet',  'EXPENSE', 'ADMIN', 'D', 'OCF', 0],
  ['6130', 'Beban Transportasi & BBM',       'EXPENSE', 'ADMIN', 'D', 'OCF', 0],
  ['6140', 'Beban ATK & Perlengkapan',       'EXPENSE', 'ADMIN', 'D', 'OCF', 0],
  ['6190', 'Beban Operasional Lain-lain',    'EXPENSE', 'ADMIN', 'D', 'OCF', 0],
  ['6200', 'Beban Penyusutan',               'EXPENSE', 'DEPRECIATION', 'D', 'NONE', 0],

  // ---------- LAIN-LAIN ----------
  ['7000', 'Beban Pajak',                    'EXPENSE', 'TAX',     'D', 'OCF', 0],
  ['7100', 'Beban Bunga & Admin Bank',       'EXPENSE', 'FINANCE', 'D', 'OCF', 0],
  ['8000', 'Selisih Stok Opname',            'EXPENSE', 'OTHER',   'D', 'NONE', 0],
];

/** Kode akun yang direferensikan oleh posting otomatis. */
const ACC = {
  CASH: '1000',
  BANK: '1010',
  AR_MARKETPLACE: '1110',
  INVENTORY: '1200',
  AP: '2000',
  TAX_PAYABLE: '2200',
  CAPITAL: '3000',
  RETAINED: '3900',
  SALES: '4000',
  SALES_RETURN: '4100',
  SALES_DISCOUNT: '4200',
  COGS: '5000',
  FEE_ADMIN: '6000',
  FEE_HANDLING: '6010',
  FEE_SHIPPING: '6020',
  FEE_VOUCHER: '6030',
  FEE_PACKING: '6040',
  FEE_ADS: '6050',
  TAX_EXPENSE: '7000',
  OTHER_EXPENSE: '6190',
  STOCK_VARIANCE: '8000',
};

module.exports = { COA, ACC };
