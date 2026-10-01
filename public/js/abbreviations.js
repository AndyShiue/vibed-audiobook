// Abbreviations that must not be taken for the end of a sentence: "Dr. Chen", "Sra. García", "ул. Ленина".
//
// Entries are lower-case and written without the final dot. Three kinds of abbreviation are recognised by their
// SHAPE instead, so they are not listed: a single letter ("J. K. Rowling", "А. С. Пушкин", "z. B."), a dotted form
// ("U.S.", "z.B.", "т.е.", "μ.μ.") and — for languages that write ordinals with a dot — a number ("am 3. Mai").
//
// When in doubt an abbreviation is left OUT: a missed abbreviation cuts a sentence in a strange place, whereas a
// missed sentence end only makes one unit a little longer. For that reason words that are also ordinary words at the
// end of a sentence ("art", "sat", "sun", "ed", "me", "on", "es") and the "and so on" family ("etc.", "usw.", "itd.",
// "ecc.", "и др.", "atd."), which usually DO end sentences, are not here. Followed by a lower-case word, any period
// continues the sentence anyway.

const words = (s) => new Set(s.split(/\s+/).filter(Boolean));

/** Never the end of a sentence on their own: titles, honorifics, forms of address, institutions, months, units of reference. */
export const ABBREVIATIONS = words(`
  mr mrs ms mx dr prof sr jr st mt gen col sgt lt cpt capt maj adm cmdr gov sen rev pres supt esq bros
  inc ltd co corp dept approx vs cf viz al ca resp jan feb apr jun jul aug sept oct nov dec ave blvd
  hr hrn frl bsp abb tel mio mrd hrsg jh jhd geb gest verh dipl ing mag sog ebd ggf vgl evtl inkl zzgl bzw
  mme mlle mmes mlles pr ste av bd env tél éd
  sra srta dra profa lic arq pág págs núm avda ud uds aprox cía ltda dña excmo ilmo vd vds
  sig sigg dott avv arch pag pagg cfr spett egr gent
  dhr mevr mw drs bijv jhr mgr
  dvs kl jfr
  esim ym ks vrt nro tri
  np tzn tzw ul godz inż ks św zob wg tj woj pow tys mln mld
  tzv např mj judr mudr sv popř příp pozn
  pl ún kb sz kft zrt bt ifj
  cca jud
  doç yrd öğr sn bkz örn cad sok mah blv
  гг ул кв проф акад стр рис см напр руб коп тыс млн млрд тов обл доц канд докт зам зав ген полк тел ред пер
  δρ αρ σελ βλ τηλ οδ κα
  tp tx tt ts gs pgs ths bs nxb
  prof hj sdr bpk yth tgl jl kec kab kel hlm
`);

/** Abbreviations that introduce a number ("No. 5", "Fig. 2", "S. 12"): only when a digit follows. ("No. He left." ends a sentence.) */
export const NUMBER_ABBREVIATIONS = words(`
  no nos nr nº n° fig figs vol vols pp art ch chap sec sect ref fol col cap tel pag pág núm blz str s p abs anm kap taf tab bl
`);

/** Languages that write ordinal numbers with a period: "am 3. Mai", "den 5. januar". */
export const ORDINAL_DOT_LANGS = words('de da nb nn no cs sk sl hr sr bs hu fi et is');
