import type { WordCatalog } from "./types";

/**
 * THE OFFICE'S MAP (nv_, cn-v1139): the words that tell a person WHERE they are and where they can
 * go, on the office's side — never the contents of an office page (those stay English for now,
 * sh_spanishCovers says so). One shelf, one voice:
 *
 *   nv_page_<slug> / nv_desc_<slug>   every office page's <PageHeader> title and its one-line
 *                                      description (lib/current-lang: const t = translator(await
 *                                      currentLangFor(user?.id)) — the page's own session, no
 *                                      second getUser; currentLang() where no id is in scope —
 *                                      then <PageHeader title={t("nv_page_x")}
 *                                      description={t("nv_desc_x")} />);
 *   nv_sched_                          the schedule's two headings that are not a PageHeader, and
 *                                      the Calendar back-link beside them;
 *   nv_add_                            the + menu's six "New …" verbs and the two sentences the
 *                                      + says when a tap can't go ({label} is the verb's own word);
 *   nv_set_<cluster id>                the Settings clusters' names (lib/settings-words);
 *   nv_role_<role>                     a person's role on the account menu.
 *
 * The English is byte for byte the literal each screen carried before the catalog (every test
 * that reads a rendered English screen still passes). Where a page's title is the same English as
 * its dock row, the Spanish is the same word as the dock's (tests/nav-titles-match-dock.test.ts);
 * the dock's own words live in lib/words/shell.ts (sh_dock_). Clickables and titles are Title Case
 * in both languages — every word, articles and prepositions included ("Lista De Precios"); a
 * description is a sentence and keeps sentence case.
 *
 * `files` is narrow on purpose: the + menu, the Settings side-tab and the PageHeader component —
 * never an office page, whose contents are not promised in Spanish yet.
 */
export const words: WordCatalog = {
  prefix: "nv_",
  files: ["src/components/global-quick-add.tsx", "src/app/(app)/settings/settings-subnav.tsx", "src/components/page-header.tsx"],
  sameInBoth: [],
  en: {
    // ── Page titles and their lines (<PageHeader>) ──
    nv_page_leads: "Leads",
    nv_desc_leads: "New requests to follow up and convert — nothing converts automatically.",
    nv_page_crm: "Customers",
    nv_desc_crm: "Everyone you work for, linked to their jobs, estimates and invoices.",
    nv_page_inspections: "Inspections",
    nv_desc_inspections: "Site visits before you price the work — fill in the inspection, then write it up into an estimate.",
    nv_page_billing: "Invoices",
    nv_desc_billing: "Who owes you, what's late, and what came in.",
    nv_page_bills: "Bills",
    nv_desc_bills: "Drop a receipt or bill anywhere on this page.",
    nv_page_reconcile: "Reconcile",
    nv_desc_reconcile: "Two records that should agree, and do not.",
    nv_page_priceList: "Price List",
    nv_desc_priceList: "Your priced catalog and reusable kits — cost, markup and sell, ready for estimates. Import a supplier's list via CSV.",
    // Said after nv_desc_priceList only when the vendors tab is there (price-list/page.tsx joins them with a space).
    nv_desc_priceListVendors: "Click any item to give it vendors, each with its own cost and sell.",
    // The tail's own tail: what a vendor IS. Byte for byte lib/vendor-words' VENDOR_MEANS (the words every
    // vendor box's help reads), pinned equal in nav.test.ts so the two can never drift.
    nv_desc_priceListVendorsMeans: "A vendor is anyone you buy from or hire: a supplier, a sub, or a brand.",
    nv_page_pay: "Pay",
    nv_desc_pay: "What you owe each person, and what you have paid them.",
    nv_page_taxReport: "Tax report",
    nv_desc_taxReport: "Sales tax collected by rate / jurisdiction — for filing & remittance.",
    nv_page_analytics: "Analytics",
    nv_desc_analytics: "How the business is actually doing — money in, money owed, win rate, job profit.",
    nv_page_recurring: "Recurring",
    nv_desc_recurring: "Jobs, invoices, and expenses that repeat. Each one is made on its day, automatically.",
    nv_page_timecards: "Timecards",
    nv_desc_timecards: "Review your crew's hours by week.",
    nv_page_compliance: "Compliance",
    nv_desc_compliance: "Licenses, certifications & permits, with their renewal dates. (Policies live in Insurance; reviews in Audits.)",
    nv_page_insurance: "Insurance",
    nv_desc_insurance: "Policies & coverage — workers' comp, general liability, auto — with their renewal dates.",
    nv_page_safety: "Safety / OSHA",
    nv_desc_safety: "Log incidents (OSHA recordables) and toolbox-talk safety meetings.",
    nv_page_audits: "Audits",
    nv_desc_audits: "Safety, OSHA, insurance & financial audits — findings, follow-up dates, nothing missed.",
    nv_page_team: "Team",
    nv_desc_team: "Your crew — invite people, set pay & charge rates, change roles, and deactivate anyone who's moved on.",
    nv_page_employeeDocs: "Employee documents",
    nv_desc_employeeDocs: "Driver's licenses, I-9, W-2, and certifications — stored securely (staff only).",
    nv_page_forms: "Forms",
    nv_desc_forms: "Field forms — safety checklists, sign-offs, and your inspection sheet.",
    nv_page_resources: "Resources",
    nv_desc_resources: "Building departments, inspectors, utilities, engineers and permit portals: the numbers and links the crew needs.",
    nv_page_handbook: "Employee handbook",
    // {company} is the company's name, or nv_desc_handbookCompany when it has none.
    nv_desc_handbook: "Policies and expectations at {company}.",
    nv_desc_handbookCompany: "the company",
    nv_page_inventory: "Shop Stock",
    nv_desc_inventory: "What's in stock, what it cost, where every roll came from and where every piece went.",
    nv_page_activity: "Activity",
    nv_desc_activity: "Recent business activity across the shop — last 30 days.",
    nv_page_audit: "Activity audit",
    nv_desc_audit: "Every action that runs through the app's action registry, newest first.",
    nv_page_tools: "Tools",
    nv_desc_tools: "Field calculators — measurements, materials, margins.",
    nv_page_settings: "Settings",
    nv_desc_settings: "Configure every part of your business.",
    nv_page_accountant: "For Your Accountant",
    nv_desc_accountant: "One spreadsheet for a month, a quarter or a year: what came in, what went out, who was paid, what's still open and what's in stock.",
    nv_page_organize: "Organize My…",
    nv_desc_organize: "Papers you snapped wait here until you file them.",
    nv_page_pettyCash: "Petty Cash",
    nv_desc_pettyCash: "Cash you took out, and older cash entries. A new cash purchase goes in through Snap Or Note or Add By Hand.",
    nv_page_quotesNew: "New Estimate",
    nv_desc_quotesNew: "Build line items by hand, or let the estimator draft them from a scope of work or an uploaded plan.",
    // quotes/page.tsx: the heading is Quotes with ?filter=quote, Estimates otherwise; one line under both.
    nv_page_quotes: "Quotes",
    nv_desc_quotes: "Estimates are time-&-materials by default — switch any one to a fixed-price quote.",
    nv_page_estimates: "Estimates",
    nv_desc_estimates: "Estimates are time-&-materials by default — switch any one to a fixed-price quote.",

    // ── The schedule's two headings (crew-board.tsx, schedule/page.tsx) ──
    nv_sched_everyonesDay: "Everyone's Day",
    nv_sched_waitingForADay: "Waiting For A Day",
    // The back-link beside both (schedule/crew-board.tsx, schedule/page.tsx's map view).
    nv_sched_calendar: "Calendar",

    // ── The + menu (global-quick-add.tsx ACTIONS, by key; Snap Or Note is sh_snapOrNote) ──
    nv_add_newLead: "New Lead",
    nv_add_newJob: "New Job",
    nv_add_newAppointment: "New Appointment",
    nv_add_newInspection: "New Inspection",
    nv_add_newEstimate: "New Estimate",
    nv_add_newInvoice: "New Invoice",
    // Said under the rows when a tap can't go; {label} is the row's own word (quickAddGo).
    nv_add_noSignal: "No signal right now, so {label} can't open. Tap it again once you have a bar or two.",
    nv_add_stillSendingOne: "Snap Or Note is still sending 1 file, and reloading now would stop it. Tap {label} again once it's in.",
    nv_add_stillSendingMany: "Snap Or Note is still sending {n} files, and reloading now would stop them. Tap {label} again once they're in.",

    // ── The Settings clusters (settings/page.tsx, by cluster id through lib/settings-words; You is sh_you) ──
    nv_set_company: "Company",
    nv_set_playbook: "Playbook",
    nv_set_features: "Features",
    nv_set_money: "Money",
    nv_set_docs: "Estimates & Invoices",
    nv_set_getpaid: "Getting Paid",
    nv_set_crew: "Crew & Time",
    nv_set_customers: "Customers",
    nv_set_website: "Website",
    nv_set_content: "Photos & Pages",
    nv_set_integrations: "Connections",

    // ── A person's role (account-menu.tsx, by profiles.role through lib/settings-words roleLabel) ──
    nv_role_owner: "Owner",
    nv_role_admin: "Admin",
    nv_role_office: "Office",
    nv_role_tech: "Tech",
  },
  es: {
    nv_page_leads: "Prospectos",
    nv_desc_leads: "Solicitudes nuevas para dar seguimiento y convertir. Nada se convierte solo.",
    nv_page_crm: "Clientes",
    nv_desc_crm: "Todas las personas para las que trabajas, con sus trabajos, presupuestos y facturas.",
    nv_page_inspections: "Inspecciones",
    nv_desc_inspections: "Visitas al sitio antes de poner precio al trabajo: llena la inspección y luego conviértela en un presupuesto.",
    nv_page_billing: "Facturas",
    nv_desc_billing: "Quién te debe, qué está atrasado y qué entró.",
    nv_page_bills: "Cuentas",
    nv_desc_bills: "Suelta un recibo o una cuenta en cualquier parte de esta página.",
    nv_page_reconcile: "Conciliar",
    nv_desc_reconcile: "Dos registros que deberían coincidir, y no coinciden.",
    nv_page_priceList: "Lista De Precios",
    nv_desc_priceList: "Tu catálogo con precios y tus kits reutilizables: costo, sobreprecio y venta, listos para los presupuestos. Importa la lista de un proveedor por CSV.",
    nv_desc_priceListVendors: "Toca cualquier artículo para darle proveedores, cada uno con su propio costo y venta.",
    nv_desc_priceListVendorsMeans: "Un proveedor es cualquiera a quien le compras o contratas: una casa de materiales, un subcontratista o una marca.",
    nv_page_pay: "Nómina",
    nv_desc_pay: "Lo que le debes a cada persona y lo que ya le pagaste.",
    nv_page_taxReport: "Reporte De Impuestos",
    nv_desc_taxReport: "Impuesto sobre ventas cobrado por tasa / jurisdicción, para declarar y pagar.",
    nv_page_analytics: "Análisis",
    nv_desc_analytics: "Cómo va el negocio de verdad: dinero que entra, dinero que te deben, tasa de cierre, ganancia por trabajo.",
    nv_page_recurring: "Recurrentes",
    nv_desc_recurring: "Trabajos, facturas y gastos que se repiten. Cada uno se crea en su día, automáticamente.",
    nv_page_timecards: "Tarjetas De Tiempo",
    nv_desc_timecards: "Revisa las horas de tu cuadrilla por semana.",
    nv_page_compliance: "Cumplimiento",
    nv_desc_compliance: "Licencias, certificaciones y permisos, con sus fechas de renovación. (Las pólizas viven en Seguros; las revisiones en Auditorías.)",
    nv_page_insurance: "Seguros",
    nv_desc_insurance: "Pólizas y cobertura (compensación laboral, responsabilidad civil, auto) con sus fechas de renovación.",
    nv_page_safety: "Seguridad / OSHA",
    nv_desc_safety: "Registra incidentes (reportables a OSHA) y pláticas de seguridad.",
    nv_page_audits: "Auditorías",
    nv_desc_audits: "Auditorías de seguridad, OSHA, seguros y finanzas: hallazgos, fechas de seguimiento, nada se pasa por alto.",
    nv_page_team: "Equipo",
    nv_desc_team: "Tu cuadrilla: invita gente, fija tarifas de pago y de cobro, cambia roles y desactiva a quien ya se fue.",
    nv_page_employeeDocs: "Documentos Del Empleado",
    nv_desc_employeeDocs: "Licencias de conducir, I-9, W-2 y certificaciones, guardadas de forma segura (solo oficina).",
    nv_page_forms: "Formularios",
    nv_desc_forms: "Formularios de campo: listas de seguridad, firmas de conformidad y tu hoja de inspección.",
    nv_page_resources: "Recursos",
    nv_desc_resources: "Departamentos de construcción, inspectores, servicios públicos, ingenieros y portales de permisos: los números y enlaces que la cuadrilla necesita.",
    nv_page_handbook: "Manual Del Empleado",
    nv_desc_handbook: "Políticas y expectativas en {company}.",
    nv_desc_handbookCompany: "la empresa",
    nv_page_inventory: "Inventario",
    nv_desc_inventory: "Qué hay en inventario, qué costó, de dónde vino cada rollo y a dónde fue cada pieza.",
    nv_page_activity: "Actividad",
    nv_desc_activity: "Actividad reciente del negocio en todo el taller: los últimos 30 días.",
    nv_page_audit: "Auditoría De Actividad",
    nv_desc_audit: "Cada acción que pasa por el registro de acciones de la app, la más reciente primero.",
    nv_page_tools: "Herramientas",
    nv_desc_tools: "Calculadoras de campo: medidas, materiales, márgenes.",
    nv_page_settings: "Ajustes",
    nv_desc_settings: "Configura cada parte de tu negocio.",
    nv_page_accountant: "Para Tu Contador",
    nv_desc_accountant: "Una hoja de cálculo para un mes, un trimestre o un año: qué entró, qué salió, a quién se le pagó, qué sigue abierto y qué hay en inventario.",
    nv_page_organize: "Organizar Mis…",
    nv_desc_organize: "Los papeles que fotografiaste esperan aquí hasta que los archives.",
    nv_page_pettyCash: "Caja Chica",
    nv_desc_pettyCash: "Efectivo que sacaste y entradas de efectivo anteriores. Una compra nueva en efectivo entra por Foto O Nota o Agregar A Mano.",
    nv_page_quotesNew: "Nuevo Presupuesto",
    nv_desc_quotesNew: "Arma las partidas a mano, o deja que el estimador las redacte desde un alcance de trabajo o un plano subido.",
    nv_page_quotes: "Cotizaciones",
    nv_desc_quotes: "Los presupuestos son por tiempo y materiales de forma predeterminada; cambia cualquiera a una cotización de precio fijo.",
    nv_page_estimates: "Presupuestos",
    nv_desc_estimates: "Los presupuestos son por tiempo y materiales de forma predeterminada; cambia cualquiera a una cotización de precio fijo.",

    nv_sched_everyonesDay: "El Día De Todos",
    nv_sched_waitingForADay: "Esperando Un Día",
    nv_sched_calendar: "Calendario",

    nv_add_newLead: "Nuevo Prospecto",
    nv_add_newJob: "Nuevo Trabajo",
    nv_add_newAppointment: "Nueva Cita",
    nv_add_newInspection: "Nueva Inspección",
    nv_add_newEstimate: "Nuevo Presupuesto",
    nv_add_newInvoice: "Nueva Factura",
    nv_add_noSignal: "No hay señal ahora, así que {label} no puede abrir. Vuelve a tocar {label} cuando tengas una o dos barras.",
    nv_add_stillSendingOne: "Foto O Nota todavía está enviando 1 archivo, y recargar ahora lo detendría. Toca {label} de nuevo cuando ya esté.",
    nv_add_stillSendingMany: "Foto O Nota todavía está enviando {n} archivos, y recargar ahora los detendría. Toca {label} de nuevo cuando ya estén.",

    nv_set_company: "Empresa",
    nv_set_playbook: "Guía",
    nv_set_features: "Funciones",
    nv_set_money: "Dinero",
    nv_set_docs: "Presupuestos Y Facturas",
    nv_set_getpaid: "Cobros",
    nv_set_crew: "Cuadrilla Y Tiempo",
    nv_set_customers: "Clientes",
    nv_set_website: "Sitio Web",
    nv_set_content: "Fotos Y Páginas",
    nv_set_integrations: "Conexiones",

    nv_role_owner: "Dueño",
    nv_role_admin: "Administrador",
    nv_role_office: "Oficina",
    nv_role_tech: "Técnico",
  },
};
