'use strict';
/**
 * Daftar kanal penjualan.
 *
 * Ditaruh di satu berkas supaya penambahan kanal baru cukup satu baris dan
 * tidak menyisakan salinan daftar yang tertinggal di modul lain.
 */
const CHANNELS = ['OFFLINE_WA', 'SOCIAL_MEDIA', 'WEBSITE', 'SHOPEE', 'TOKOPEDIA', 'TIKTOK_SHOP', 'LAZADA'];

const CHANNEL_LABEL = {
  OFFLINE_WA: 'Offline / WhatsApp',
  SOCIAL_MEDIA: 'Social Media',
  WEBSITE: 'Website',
  SHOPEE: 'Shopee',
  TOKOPEDIA: 'Tokopedia',
  TIKTOK_SHOP: 'TikTok Shop',
  LAZADA: 'Lazada',
};

/** Kanal yang uangnya masuk lewat rekening penampung marketplace, bukan kas. */
const CHANNEL_MARKETPLACE = ['SHOPEE', 'TOKOPEDIA', 'TIKTOK_SHOP', 'LAZADA'];

module.exports = { CHANNELS, CHANNEL_LABEL, CHANNEL_MARKETPLACE };
