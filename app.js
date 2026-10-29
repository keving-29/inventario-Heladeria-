// =============================================
// CONFIGURACIÓN
// =============================================
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxKd7Tazw9VHNCPWa6l0o6Xrto6v37YJPGL-PehM-6sA9sSCZZ36uJYpXPEtw6gU09NyA/exec';

// =============================================
// ESTADO LOCAL
// =============================================
let DB = {
  usuarios:  [],
  productos: [],
  ventas:    [],
  clientes:  [],
  deudores:  [],
  anticipos: [],
  proveedores: [],
  gastos:    [],
  costos:    [],
  traslados: [],
  liquidaciones: [],
  config:    { stockMin: 5, trasladoContador: 0 }
};

let sesion              = null;
let precioCompraVisible = false;
let carrito             = [];
let editandoProductoId  = null;
let carritoItemEditando = null;
let rapidoProductoActual = null;
let periodoreporte      = 'semana';
let traslado             = [];
let trasladoProductoActual = null;
let facturaVentaActual  = null;
let autoSyncInterval    = null;
let resultadosVenta     = [];
let resultadosVentaTodos = [];
let ventaResultadosMostrar = 8;
let indiceVenta         = 0;
let resultadosTraslado  = [];
let indiceTraslado      = 0;
let cotizacion            = [];
let cotizacionProductoActual = null;
let resultadosCotizacion = [];
let indiceCotizacion     = 0;
let editandoDeudorId    = null;
let deudorAbonoActual   = null;
let tipoAbonoActual     = 'deudor';
let gastoCategoriaSeleccionada = null;
let productosDeudor   = [];
let productosAnticipo = [];
let editandoAnticipoId  = null;
let proveedorAbonoActual = null;
let inventarioMostrar = 10;
const buscadoresProducto = {};

// Secciones privadas: piden clave cada vez que se intenta entrar
const CLAVE_SECCIONES = 'cremhelado1228';
const SECCIONES_PROTEGIDAS = [];   // sin claves: todas las secciones abren directo
let panelPendiente = null;

// Sync automático/login: solo trae ventas recientes (más que suficiente para
// Dashboard y Ventas). Historial y Reportes piden el historial completo aparte.
const VENTAS_DIAS_SYNC_LIGERO = 120;

// Clientes (venta / deudor / anticipo)
const buscadoresCliente = {};
let clienteVenta = null;
let clienteCotizacion = null;
let clienteDeudor = null;
let clienteAnticipo = null;
let clienteModalContexto = null;

// =============================================
// GOOGLE SHEETS
// =============================================
// Nunca esperar la red para siempre: si no responde en 15s, se cancela y se sigue trabajando localmente.
function fetchConTimeout(url, opciones, ms = 15000) {
  const control = new AbortController();
  const t = setTimeout(() => control.abort(), ms);
  return fetch(url, { ...opciones, signal: control.signal }).finally(() => clearTimeout(t));
}

// ventasDias limita cuántos días de historial de Ventas trae el backend en cada
// sincronización. Sin esto, cada sync (cada 60s) descargaba TODO el historial de
// ventas desde el inicio de los tiempos, y eso se vuelve cada vez más lento a
// medida que crece la hoja. El sync automático solo necesita datos recientes
// (Dashboard = hoy); Historial y Reportes piden el historial completo aparte,
// solo cuando el usuario realmente entra a esas secciones.
async function sheetsLeer(ventasDias) {
  try {
    setSyncStatus('cargando');
    let url = SCRIPT_URL + '?action=getAll';
    if (ventasDias) url += '&ventasDias=' + ventasDias;
    const r = await fetchConTimeout(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (!d || d.ok !== true) throw new Error((d && d.error) || 'Google Sheets rechazó la lectura.');
    setSyncStatus('conectado');
    return d.data || {};
  } catch (e) {
    setSyncStatus('error');
    return null;
  }
}

// filaOId: número de fila fija (ej. la fila 2 de Config) o el id del registro
// (para Productos/Ventas/Deudores/Anticipos/Proveedores/Gastos). Usar el id en
// vez de calcular la fila a partir de la posición en el array local evita que
// un update/delete caiga en la fila equivocada cuando el array local y las
// filas reales de la hoja quedan desalineados (por una fila vieja, un delete
// anterior, o una sincronización a medio camino).
async function sheetsEscribir(accion, hoja, datos, filaOId, columna) {
  try {
    setSyncStatus('cargando');
    const body = { action: accion, sheet: hoja, data: datos };
    if (typeof filaOId === 'number') body.row = filaOId;
    else if (filaOId) body.id = filaOId;
    if (columna) body.columna = columna;

    const r = await fetchConTimeout(SCRIPT_URL, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);

    // Apps Script puede responder HTTP 200 aunque la operación haya terminado
    // con ok:false. Aquí comprobamos la respuesta real para no mostrar un
    // "guardado" falso.
    const respuesta = await r.json();
    if (!respuesta || respuesta.ok !== true) {
      throw new Error((respuesta && respuesta.error) || 'Google Sheets rechazó la operación.');
    }

    setSyncStatus('conectado');
    return true;
  } catch (e) {
    setSyncStatus('error');
    console.error(`Error escribiendo en ${hoja} (${accion}):`, e);
    return false;
  }
}

async function sincronizar(ventasDias) {
  const datos = await sheetsLeer(ventasDias);
  if (!datos) return;

  if (datos.Productos && datos.Productos.length > 1) {
    DB.productos = datos.Productos.slice(1).map(f => ({
      id: String(f[0]), ref: String(f[1]||''), nombre: String(f[2]||''),
      pcompra: Number(f[3])||0, pventa1: Number(f[4])||0,
      pventa2: Number(f[5])||0, stock: Number(f[6])||0,
      alegraId: String(f[7]||''),
      // Columna I (f[8]) es "unidadOK", uso interno de la migración a
      // Alegra — no se toca desde aquí. El código de barras de fábrica va
      // en la columna J (f[9]), aparte, para no chocar con nada de eso.
      codigoBarras: String(f[9]||'')
    }));
  }

  if (datos.Ventas && datos.Ventas.length > 1) {
    DB.ventas = datos.Ventas.slice(1).map(f => ({
      id: String(f[0]), fecha: String(f[1]), hora: String(f[2]),
      total: Number(f[3])||0, ganancia: Number(f[4])||0,
      nota: String(f[5]||''), metodoPago: String(f[6]||'efectivo'),
      items: parsearJSON(f[7]),
      clienteId: String(f[8]||''), clienteNombre: String(f[9]||''),
      clienteCedula: String(f[10]||''), clienteTelefono: String(f[11]||''),
      clienteDireccion: String(f[12]||''),
      pagadoAhora: (f[13]!==undefined&&f[13]!=='') ? Number(f[13]) : undefined,
      saldoPendiente: (f[14]!==undefined&&f[14]!=='') ? Number(f[14]) : undefined,
      pagoRecibido: (f[15]!==undefined&&f[15]!=='') ? Number(f[15]) : undefined,
      cambio: (f[16]!==undefined&&f[16]!=='') ? Number(f[16]) : undefined,
      pagoEf: (f[17]!==undefined&&f[17]!=='') ? Number(f[17]) : undefined,
      pagoTr: (f[18]!==undefined&&f[18]!=='') ? Number(f[18]) : undefined
    }));
  }

  if (datos.Usuarios && datos.Usuarios.length > 1) {
    DB.usuarios = datos.Usuarios.slice(1).map(f => ({
      user: String(f[0]), pass: String(f[1]), rol: String(f[2]||'vendedor')
    }));
  }

  if (datos.Clientes && datos.Clientes.length > 1) {
    DB.clientes = datos.Clientes.slice(1).map(f => ({
      id: String(f[0]), nombre: String(f[1]||''), cedula: String(f[2]||''),
      telefono: String(f[3]||''), direccion: String(f[4]||''), correo: String(f[5]||''),
      tipoDoc: String(f[6]||'CC'),
      precios: parsearPreciosCliente(f[7])
    }));
  }

  if (Array.isArray(datos.Deudores)) {
    DB.deudores = datos.Deudores.length > 1
      ? datos.Deudores.slice(1).map(f => ({
          id: String(f[0]), clienteId: String(f[1]||''), nombre: String(f[2]||''),
          cedula: String(f[3]||''), telefono: String(f[4]||''), direccion: String(f[5]||''),
          productos: parsearJSON(f[6]), monto: Number(f[7])||0,
          nota: String(f[8]||''), fecha: isoAFechaCO(f[9]), hora: String(f[10]||''), fechaLimite: isoAFechaCO(f[11]),
          abonos: parsearJSON(f[12]), pagada: String(f[13])==='true'
        }))
      : [];
  }

  if (Array.isArray(datos.Anticipos)) {
    DB.anticipos = datos.Anticipos.length > 1
      ? datos.Anticipos.slice(1).map(f => ({
          id: String(f[0]), clienteId: String(f[1]||''), nombre: String(f[2]||''),
          cedula: String(f[3]||''), telefono: String(f[4]||''), direccion: String(f[5]||''),
          productos: parsearJSON(f[6]), monto: Number(f[7])||0,
          nota: String(f[8]||''), fecha: isoAFechaCO(f[9]), hora: String(f[10]||''), fechaLimite: isoAFechaCO(f[11]),
          abonos: parsearJSON(f[12]), pagada: String(f[13])==='true', descontado: String(f[14])==='true'
        }))
      : [];
  }

  if (datos.Proveedores && datos.Proveedores.length > 1) {
    DB.proveedores = datos.Proveedores.slice(1).map(f => ({
      id: String(f[0]), empresa: String(f[1]||''), fechaLlegadaPedido: isoAFechaCO(f[2]),
      monto: Number(f[3])||0, numeroCuotas: Number(f[4])||1, fechaLimite: isoAFechaCO(f[5]),
      fecha: String(f[6]||''), hora: String(f[7]||''),
      abonos: parsearJSON(f[8]), pagada: String(f[9])==='true'
    }));
  }

  if (datos.Gastos && datos.Gastos.length > 1) {
    DB.gastos = datos.Gastos.slice(1).map(f => ({
      id: String(f[0]), categoria: String(f[1]||''), monto: Number(f[2])||0,
      metodoPago: String(f[3]||'efectivo'), fecha: isoAFechaCO(f[4]), hora: String(f[5]||''),
      nota: String(f[6]||''),
      efectivo: (f[7]!==undefined&&f[7]!=='') ? Number(f[7]) : undefined,
      transferencia: (f[8]!==undefined&&f[8]!=='') ? Number(f[8]) : undefined
    }));
  }

  if (datos.Costos && datos.Costos.length > 1) {
    DB.costos = datos.Costos.slice(1).map(f => ({
      id: String(f[0]), categoria: String(f[1]||''), monto: Number(f[2])||0,
      metodoPago: String(f[3]||'efectivo'), fecha: isoAFechaCO(f[4]), hora: String(f[5]||''),
      nota: String(f[6]||''),
      efectivo: (f[7]!==undefined&&f[7]!=='') ? Number(f[7]) : undefined,
      transferencia: (f[8]!==undefined&&f[8]!=='') ? Number(f[8]) : undefined
    }));
  }

  if (datos.Traslados && datos.Traslados.length > 1) {
    DB.traslados = datos.Traslados.slice(1).map(f => ({
      id: String(f[0]), numero: String(f[1]||''), fecha: isoAFechaCO(f[2]), hora: String(f[3]||''),
      items: parsearJSON(f[4])
    }));
  }

  if (Array.isArray(datos.Liquidaciones)) {
    DB.liquidaciones = datos.Liquidaciones.length > 1
      ? datos.Liquidaciones.slice(1).map(parsearLiquidacion)
      : [];
  }

  if (datos.Config && datos.Config.length > 1) {
    DB.config.stockMin = Number(datos.Config[1][0]) || 5;
    DB.config.trasladoContador = Number(datos.Config[1][1]) || 0;
  }

  guardarLocal();
  mostrarToast('Datos sincronizados ✓');
}

async function inicializarSheets() {
  const datos = await sheetsLeer();
  if (!datos) return;
  if (!datos.Productos || datos.Productos.length === 0)
    await sheetsEscribir('append', 'Productos', ['ID','Ref','Nombre','PCompra','PVenta1','PVenta2','Stock']);
  if (!datos.Ventas || datos.Ventas.length === 0)
    await sheetsEscribir('append', 'Ventas', ['ID','Fecha','Hora','Total','Ganancia','Nota','MetodoPago','Items','ClienteId','ClienteNombre','ClienteCedula','ClienteTelefono','ClienteDireccion','PagadoAhora','SaldoPendiente','PagoRecibido','Cambio','PagoEfectivo','PagoTransferencia']);
  if (!datos.Usuarios || datos.Usuarios.length === 0) {
    await sheetsEscribir('append', 'Usuarios', ['Usuario','Contraseña','Rol']);
    await sheetsEscribir('append', 'Usuarios', ['admin','CremHelado2812','admin']);
  }
  if (!datos.Clientes || datos.Clientes.length === 0)
    await sheetsEscribir('append', 'Clientes', ['ID','Nombre','Cedula','Telefono','Direccion','Correo','TipoDoc','Precios']);
  else if (datos.Clientes[0] && String(datos.Clientes[0][7]||'') !== 'Precios')
    await sheetsEscribir('update', 'Clientes', ['Precios'], 1, 8);
  if (!datos.Deudores || datos.Deudores.length === 0)
    await sheetsEscribir('append', 'Deudores', ['ID','ClienteId','Nombre','Cedula','Telefono','Direccion','Productos','Monto','Nota','Fecha','Hora','FechaLimite','Abonos','Pagada']);
  if (!datos.Anticipos || datos.Anticipos.length === 0)
    await sheetsEscribir('append', 'Anticipos', ['ID','ClienteId','Nombre','Cedula','Telefono','Direccion','Productos','Monto','Nota','Fecha','Hora','FechaLimite','Abonos','Pagada','Descontado']);
  if (!datos.Proveedores || datos.Proveedores.length === 0)
    await sheetsEscribir('append', 'Proveedores', ['ID','Empresa','FechaLlegadaPedido','Monto','NumeroCuotas','FechaLimite','Fecha','Hora','Abonos','Pagada']);
  if (!datos.Gastos || datos.Gastos.length === 0)
    await sheetsEscribir('append', 'Gastos', ['ID','Categoria','Monto','MetodoPago','Fecha','Hora','Nota','Efectivo','Transferencia']);
  if (!datos.Costos || datos.Costos.length === 0)
    await sheetsEscribir('append', 'Costos', ['ID','Categoria','Monto','MetodoPago','Fecha','Hora','Nota','Efectivo','Transferencia']);
  if (!datos.Traslados || datos.Traslados.length === 0)
    await sheetsEscribir('append', 'Traslados', ['ID','Numero','Fecha','Hora','Items']);
  if (!datos.Liquidaciones || datos.Liquidaciones.length === 0)
    await sheetsEscribir('append', 'Liquidaciones', ['ID','ClienteId','Cliente','Fecha','Hora','Items','Unidades','TotalPagar','VentaPublico','Ganancia','Pagos','Nota']);
  if (!datos.Config || datos.Config.length === 0) {
    await sheetsEscribir('append', 'Config', ['StockMin','TrasladoContador']);
    await sheetsEscribir('append', 'Config', [5, 0]);
  }
  await sincronizar(VENTAS_DIAS_SYNC_LIGERO);
}

// =============================================
// LOCAL STORAGE
// =============================================
function guardarLocal() { localStorage.setItem('cremhelado_db', JSON.stringify(DB)); }
function cargarLocal() {
  try { const d = localStorage.getItem('cremhelado_db'); if (d) DB = JSON.parse(d); } catch(e) {}
}
function guardarSesion(u) { localStorage.setItem('cremhelado_sesion', JSON.stringify(u)); }
function cargarSesion() {
  try { const s = localStorage.getItem('cremhelado_sesion'); return s ? JSON.parse(s) : null; } catch(e) { return null; }
}
function borrarSesion() { localStorage.removeItem('cremhelado_sesion'); }

// =============================================
// UTILIDADES
// =============================================
function fmt(n) { return '$' + Math.round(n).toLocaleString('es-CO'); }
function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function esc(t) {
  return String(t).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Tasa de IVA usada en el ticket, la cotización y el helper de precio+IVA
// al agregar un producto. Colombia: 19%.
const TASA_IVA = 0.19;

// Búsqueda de producto por texto (nombre, Ref propia, o código de barras
// de fábrica si el producto lo tiene guardado). Se usa en todos los
// buscadores (Ventas, Inventario, Traslado, Cotización, Deudores,
// Anticipos) para que escribir o escanear cualquiera de los tres siempre
// encuentre el producto.
function productoCoincideTexto(p, q) {
  return p.nombre.toLowerCase().includes(q)
    || p.ref.toLowerCase().includes(q)
    || (p.codigoBarras && p.codigoBarras.toLowerCase().includes(q));
}

// Coincidencia EXACTA por Ref o código de barras — esto es lo que distingue
// un escaneo (el lector manda el código completo + Enter) de una búsqueda
// manual por nombre.
function productoCoincideExacto(p, q) {
  const qq = q.toLowerCase();
  return p.ref.toLowerCase() === qq
    || (p.codigoBarras && p.codigoBarras.toLowerCase() === qq);
}

// Convierte un número entero de pesos a su forma escrita en español,
// para el "Valor en letras" del ticket y la cotización.
const NUM_UNIDADES = ['','uno','dos','tres','cuatro','cinco','seis','siete','ocho','nueve','diez',
  'once','doce','trece','catorce','quince','dieciséis','diecisiete','dieciocho','diecinueve'];
const NUM_DECENAS = ['','','veinte','treinta','cuarenta','cincuenta','sesenta','setenta','ochenta','noventa'];
const NUM_CENTENAS = ['','ciento','doscientos','trescientos','cuatrocientos','quinientos','seiscientos','setecientos','ochocientos','novecientos'];

function numeroATextoGrupo(n) {
  if (n === 0) return '';
  if (n === 100) return 'cien';
  let texto = '';
  const c = Math.floor(n / 100), d = Math.floor((n % 100) / 10), u = n % 10;
  if (c > 0) texto += NUM_CENTENAS[c] + ' ';
  const resto = n % 100;
  if (resto < 20) {
    texto += NUM_UNIDADES[resto];
  } else if (d === 2 && u > 0) {
    texto += 'veinti' + NUM_UNIDADES[u];
  } else {
    texto += NUM_DECENAS[d] + (u > 0 ? ' y ' + NUM_UNIDADES[u] : '');
  }
  return texto.trim();
}

function numeroALetras(valor) {
  let n = Math.round(Math.abs(valor || 0));
  if (n === 0) return 'cero pesos m/cte';

  const millones = Math.floor(n / 1000000);
  const miles = Math.floor((n % 1000000) / 1000);
  const cientos = n % 1000;

  let partes = [];
  if (millones > 0) {
    partes.push((millones === 1 ? 'un millón' : numeroATextoGrupo(millones) + ' millones'));
  }
  if (miles > 0) {
    partes.push((miles === 1 ? 'mil' : numeroATextoGrupo(miles) + ' mil'));
  }
  if (cientos > 0) {
    partes.push(numeroATextoGrupo(cientos));
  }

  let texto = partes.join(' ').trim();
  texto = texto.charAt(0).toUpperCase() + texto.slice(1);
  return texto + ' pesos m/cte';
}
function parsearJSON(t) { try { return JSON.parse(t); } catch(e) { return []; } }

// Fecha y hora en formato colombiano (DD/MM/AAAA, 12 horas)
function fechaCO(d = new Date()) {
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}
function horaCO(d = new Date()) {
  return d.toLocaleTimeString('es-CO', {hour:'2-digit', minute:'2-digit', hour12:true});
}
function parseFechaCO(str) {
  const [dd,mm,yyyy] = String(str).split('/').map(Number);
  return new Date(yyyy||1970, (mm||1)-1, dd||1);
}
function isoAFechaCO(iso) {
  if (!iso) return '';

  const valor = String(iso).trim();

  // Si ya viene en formato colombiano, lo dejamos igual
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(valor)) {
    return valor;
  }

  // Si viene como YYYY-MM-DD o YYYY-MM-DDTHH:mm:ss...
  const match = valor.match(/^(\d{4})-(\d{2})-(\d{2})/);

  if (match) {
    const [, anio, mes, dia] = match;
    return `${dia}/${mes}/${anio}`;
  }

  return valor;
}
function coAIso(co) {
  if (!co) return '';
  const [d,m,y] = String(co).split('/');
  if (!d||!m||!y) return '';
  return `${y}-${m}-${d}`;
}

function setSyncStatus(estado) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.textContent = {conectado:'Conectado',cargando:'Sincronizando...',error:'Sin conexión'}[estado]||estado;
  el.className = estado;
}

function mostrarToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('visible');
  setTimeout(() => t.classList.remove('visible'), 3000);
}

function abrirModal(id)  { document.getElementById(id).classList.remove('hidden'); }
function cerrarModal(id) { document.getElementById(id).classList.add('hidden'); }

// =============================================
// LOGIN
// =============================================
function doLogin() {
  const u = document.getElementById('login-user').value.trim();
  const p = document.getElementById('login-pass').value;
  const found = DB.usuarios.find(x => x.user === u && x.pass === p);
  if (found) {
    sesion = found;
    guardarSesion(found);
    entrarAlApp();
    inicializarSheets();
  } else {
    document.getElementById('login-error').classList.remove('hidden');
  }
}

function entrarAlApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('topbar-user').textContent = sesion.user + ' · ' + sesion.rol;
  document.getElementById('hist-fecha').value = new Date().toISOString().split('T')[0];
  mostrarPanelInterno('ventas');
  iniciarAutoSync();
}

function iniciarAutoSync() {
  if (autoSyncInterval) clearInterval(autoSyncInterval);
  autoSyncInterval = setInterval(() => { if (sesion) sincronizar(VENTAS_DIAS_SYNC_LIGERO); }, 60000);
}

function doLogout() {
  sesion = null; precioCompraVisible = false; carrito = [];
  if (autoSyncInterval) { clearInterval(autoSyncInterval); autoSyncInterval = null; }
  borrarSesion();
  document.getElementById('app').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('login-user').value = '';
  document.getElementById('login-pass').value = '';
  document.getElementById('login-error').classList.add('hidden');
}

// =============================================
// NAVEGACIÓN
// =============================================
function mostrarPanel(panel) {
  if (SECCIONES_PROTEGIDAS.includes(panel)) { solicitarClavePanel(panel); return; }
  mostrarPanelInterno(panel);
}

function solicitarClavePanel(panel) {
  panelPendiente = panel;
  document.getElementById('clave-panel-input').value = '';
  document.getElementById('clave-panel-error').classList.add('hidden');
  abrirModal('modal-clave-panel');
  setTimeout(() => document.getElementById('clave-panel-input').focus(), 100);
}

function verificarClavePanel() {
  const v = document.getElementById('clave-panel-input').value;
  if (v === CLAVE_SECCIONES) {
    cerrarModal('modal-clave-panel');
    const panel = panelPendiente;
    panelPendiente = null;
    if (panel) mostrarPanelInterno(panel);
  } else {
    document.getElementById('clave-panel-error').classList.remove('hidden');
  }
}

async function mostrarPanelInterno(panel) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('panel-' + panel).classList.add('active');
  document.querySelector(`.nav-tab[data-tab="${panel}"]`).classList.add('active');

  if (panel === 'dashboard')  renderDashboard();
  if (panel === 'inventario') {
    renderInventario();
    setTimeout(() => document.getElementById('inv-search').focus(), 100);
  }
  if (panel === 'clientes')   renderClientes();
  if (panel === 'precios')    { mostrarClientePrecios(); renderPreciosEditor(); }
  if (panel === 'liquidacion') { liqMostrarVendedor(); renderLiqEditor(); renderLiqHistorial(); }
  if (panel === 'deudores')   renderDeudores();
  if (panel === 'anticipos')  renderAnticipos();
  if (panel === 'proveedores') renderProveedores();
  if (panel === 'gastos')     renderGastos();
  if (panel === 'costos')     renderCostos();
  // El sync automático solo trae ventas recientes; Historial/Reportes pueden
  // necesitar cualquier fecha pasada, así que aquí sí se trae el historial completo.
  if (panel === 'historial')  { renderHistorial(); await sincronizar(); renderHistorial(); }
  if (panel === 'reportes')   { renderReportes(periodoreporte); await sincronizar(); renderReportes(periodoreporte); }
  if (panel === 'config')     renderConfig();
  if (panel === 'ventas') {
    carrito = [];
    renderCarrito();
    quitarClienteVenta();
    document.getElementById('venta-cliente-buscar').value = '';
    document.getElementById('venta-cliente-resultados').innerHTML = '';
    document.getElementById('venta-search').value = '';
    document.getElementById('venta-resultados').innerHTML = '';
    resultadosVenta = [];
    resultadosVentaTodos = [];
    ventaResultadosMostrar = 8;
    setTimeout(() => document.getElementById('venta-search').focus(), 100);
  }
  if (panel === 'traslado') {
    renderTraslado();
    renderTrasladosHistorial();
    document.getElementById('traslado-search').value = '';
    document.getElementById('traslado-resultados').innerHTML = '';
    resultadosTraslado = [];
    setTimeout(() => document.getElementById('traslado-search').focus(), 100);
  }
  if (panel === 'cotizacion') {
    renderCotizacion();
    document.getElementById('cotizacion-search').value = '';
    document.getElementById('cotizacion-resultados').innerHTML = '';
    resultadosCotizacion = [];
    setTimeout(() => document.getElementById('cotizacion-search').focus(), 100);
  }

  cerrarSidebarMovil();
}

function cerrarSidebarMovil() {
  document.getElementById('sidebar').classList.remove('abierto');
  document.getElementById('sidebar-backdrop').classList.remove('visible');
}

// =============================================
// TRASLADO (no afecta stock)
// =============================================
function buscarProductoTraslado() {
  const q = document.getElementById('traslado-search').value.toLowerCase();
  const cont = document.getElementById('traslado-resultados');
  indiceTraslado = 0;
  if (!q) { cont.innerHTML=''; resultadosTraslado=[]; return; }

  resultadosTraslado = DB.productos
    .filter(p => productoCoincideTexto(p, q))
    .slice(0,8);

  if (resultadosTraslado.length===0) { cont.innerHTML='<p style="font-size:13px;color:var(--texto2);padding:8px 0">Sin resultados</p>'; return; }

  renderResultadosTraslado();
}

function renderResultadosTraslado() {
  const cont = document.getElementById('traslado-resultados');
  cont.innerHTML = `
    <div style="background:var(--card);border:0.5px solid var(--borde);border-radius:12px;overflow:hidden;margin-bottom:1rem;box-shadow:var(--sombra)">
      <div style="padding:8px 12px;background:var(--blush-claro);border-bottom:0.5px solid var(--borde);font-size:11px;color:var(--texto2);font-weight:500;text-transform:uppercase;letter-spacing:0.5px">
        Resultados — ↑↓ para navegar, Enter para agregar
      </div>
      ${resultadosTraslado.map((p,i) => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:0.5px solid var(--borde);flex-wrap:wrap;gap:8px;${i===indiceTraslado?'background:var(--rosa-claro)':''}">
          <div>
            ${i===indiceTraslado?'<span style="font-size:10px;background:var(--rosa);color:#fff;padding:2px 7px;border-radius:10px;margin-right:6px">↵ Enter</span>':''}
            <span style="font-size:14px;font-weight:500">${esc(p.nombre)}</span>
            <div style="font-size:12px;color:var(--texto2)">Código: ${esc(p.ref)} · Stock: ${p.stock} · P1: ${fmt(p.pventa1)}</div>
          </div>
          <button class="btn-primary btn-agregar-traslado" data-id="${p.id}" style="flex-shrink:0"><i class="ti ti-plus"></i> Agregar</button>
        </div>`).join('')}
    </div>`;

  cont.querySelectorAll('.btn-agregar-traslado').forEach(b =>
    b.addEventListener('click', () => agregarATraslado(b.dataset.id)));
}

function agregarATraslado(id) {
  const p = DB.productos.find(x => x.id===id);
  if (!p) return;
  trasladoProductoActual = p;
  document.getElementById('ct-nombre').textContent = p.nombre;
  document.getElementById('ct-cantidad').value = '1';
  abrirModal('modal-cantidad-traslado');
  setTimeout(() => document.getElementById('ct-cantidad').focus(), 100);

  document.getElementById('traslado-search').value = '';
  document.getElementById('traslado-resultados').innerHTML = '';
}

function cantidadEnTraslado(ref) {
  return traslado.filter(i => i.codigo === ref).reduce((a,i) => a+i.cantidad, 0);
}

function confirmarCantidadTraslado() {
  const cant = parseInt(document.getElementById('ct-cantidad').value) || 0;
  if (cant < 1) { alert('Ingresa una cantidad válida'); return; }
  const p = trasladoProductoActual;
  if (!p) return;

  const disponible = p.stock - cantidadEnTraslado(p.ref);
  if (cant > disponible) { alert(`Solo hay ${Math.max(disponible,0)} unidades disponibles en inventario.`); return; }

  traslado.push({ itemId: uid(), codigo: p.ref, nombre: p.nombre, cantidad: cant, precio: p.pventa1 });
  cerrarModal('modal-cantidad-traslado');
  renderTraslado();
  document.getElementById('traslado-search').focus();
  mostrarToast('Producto agregado al traslado ✓');
}

function eliminarDeTraslado(itemId) {
  traslado = traslado.filter(i => i.itemId !== itemId);
  renderTraslado();
}

function renderTraslado() {
  const cont = document.getElementById('traslado-contenido');
  if (traslado.length === 0) {
    cont.innerHTML = `<div class="estado-vacio"><i class="ti ti-truck"></i><p>Sin productos en el traslado.</p></div>`;
    return;
  }

  const filas = traslado.map((i, idx) => `
    <tr>
      <td>${idx+1}</td>
      <td><code style="background:var(--blush-claro);padding:2px 7px;border-radius:4px;font-size:12px">${esc(i.codigo)}</code></td>
      <td>${esc(i.nombre)}</td>
      <td style="text-align:center">${i.cantidad}</td>
      <td>${fmt(i.precio)}</td>
      <td><button class="btn-peligro btn-quitar-traslado" data-id="${i.itemId}" style="padding:5px 9px"><i class="ti ti-trash"></i></button></td>
    </tr>`).join('');

  cont.innerHTML = `
    <p style="font-size:13px;color:var(--texto2);margin:0.5rem 0">Total de productos: <strong>${traslado.length}</strong></p>
    <div class="tabla-wrap"><table>
    <thead><tr><th>#</th><th>Código</th><th>Nombre</th><th>Cantidad</th><th>Precio</th><th></th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;

  cont.querySelectorAll('.btn-quitar-traslado').forEach(b =>
    b.addEventListener('click', () => eliminarDeTraslado(b.dataset.id)));
}

// La fila 1 es el encabezado (se crea una sola vez en inicializarSheets) y la
// fila 2 son los valores actuales: se actualiza directo esa fila, sin borrar
// y reconstruir el sheet completo (eso dejaba una ventana donde una lectura
// a mitad de camino podía encontrar el sheet sin valores y devolver el
// contador en 0, reiniciando la numeración de traslados).
async function guardarConfigSheet() {
  await sheetsEscribir('update','Config',[DB.config.stockMin, DB.config.trasladoContador], 2);
}

async function siguienteNumeroTraslado() {
  DB.config.trasladoContador = (DB.config.trasladoContador||0) + 1;
  guardarLocal();
  await guardarConfigSheet();
  return 'TD-N-' + String(DB.config.trasladoContador).padStart(4,'0');
}

function prepararImpresion(idContenedor) {
  document.getElementById('traslado-print').classList.remove('activo');
  document.getElementById('venta-print').classList.remove('activo');
  document.getElementById('deudor-print').classList.remove('activo');
  document.getElementById('proveedor-print').classList.remove('activo');
  document.getElementById('cotizacion-print').classList.remove('activo');
  document.getElementById('liquidacion-print').classList.remove('activo');
  document.getElementById(idContenedor).classList.add('activo');
}

function construirHtmlTrasladoPrint(numero, fecha, hora, items) {
  const filas = items.map((i, idx) => `
    <tr>
      <td>${idx+1}</td>
      <td>${esc(i.codigo)}</td>
      <td>${esc(i.nombre)}</td>
      <td style="text-align:center">${i.cantidad}</td>
      <td>${fmt(i.precio)}</td>
    </tr>`).join('');

  return `
    <div id="tp-header">
      <h1>Crem Helado</h1>
      <p>Traslado de productos</p>
      <p style="font-weight:600;margin-top:4px">${numero}</p>
    </div>
    <div id="tp-meta">
      <span><strong>Fecha:</strong> ${fecha}</span>
      <span><strong>Hora:</strong> ${hora}</span>
    </div>
    <table>
      <thead><tr><th>#</th><th>Código</th><th>Nombre</th><th>Cantidad</th><th>Precio</th></tr></thead>
      <tbody>${filas}</tbody>
    </table>
    <p style="margin-top:12px;font-size:13px"><strong>Total de productos:</strong> ${items.length}</p>
    <div id="tp-firmas">
      <div class="tp-firma"><div class="tp-linea"></div><span>Quien realiza el traslado</span></div>
      <div class="tp-firma"><div class="tp-linea"></div><span>Quien recibe</span></div>
    </div>
  `;
}

async function guardarTrasladoRealizado(numero, fecha, hora, items) {
  const registro = { id: uid(), numero, fecha, hora, items: items.map(i=>({...i})) };
  DB.traslados.push(registro);
  guardarLocal();
  await sheetsEscribir('append','Traslados',[registro.id, registro.numero, registro.fecha, registro.hora, JSON.stringify(registro.items)]);
  return registro;
}

async function imprimirTraslado() {
  if (traslado.length === 0) { alert('Agrega productos al traslado antes de imprimir'); return; }

  const numero = await siguienteNumeroTraslado();
  const ahora = new Date();
  const fecha = fechaCO(ahora);
  const hora  = horaCO(ahora);

  await guardarTrasladoRealizado(numero, fecha, hora, traslado);
  renderTrasladosHistorial();

  document.getElementById('traslado-print-contenido').innerHTML = construirHtmlTrasladoPrint(numero, fecha, hora, traslado);
  prepararImpresion('traslado-print');
  window.print();
}

function reimprimirTraslado(registro) {
  document.getElementById('traslado-print-contenido').innerHTML =
    construirHtmlTrasladoPrint(registro.numero, registro.fecha, registro.hora, registro.items);
  prepararImpresion('traslado-print');
  window.print();
}

function renderTrasladosHistorial() {
  const cont = document.getElementById('traslados-historial-contenido');
  if (!cont) return;
  if (DB.traslados.length === 0) {
    cont.innerHTML = `<div class="estado-vacio"><i class="ti ti-history"></i><p>Sin traslados registrados todavía.</p></div>`;
    return;
  }
  const ordenados = DB.traslados.slice().reverse();
  const filas = ordenados.map(t => `
    <tr>
      <td style="font-weight:500">${esc(t.numero)}</td>
      <td>${t.fecha}</td>
      <td>${t.hora}</td>
      <td style="text-align:center">${t.items.length}</td>
      <td><button class="btn-secundario btn-reimprimir-traslado" data-id="${t.id}" style="padding:6px 10px"><i class="ti ti-printer"></i></button></td>
    </tr>`).join('');
  cont.innerHTML = `<div class="tabla-wrap"><table>
    <thead><tr><th>Número</th><th>Fecha</th><th>Hora</th><th>Productos</th><th></th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;
  cont.querySelectorAll('.btn-reimprimir-traslado').forEach(b => b.addEventListener('click', () => {
    const t = DB.traslados.find(x => x.id === b.dataset.id);
    if (t) reimprimirTraslado(t);
  }));
}

// =============================================
// COTIZACIÓN (no afecta stock ni se registra como venta; no se guarda
// en Google Sheets, solo se arma en pantalla y se imprime)
// =============================================
function buscarProductoCotizacion() {
  const q = document.getElementById('cotizacion-search').value.toLowerCase();
  const cont = document.getElementById('cotizacion-resultados');
  indiceCotizacion = 0;
  if (!q) { cont.innerHTML=''; resultadosCotizacion=[]; return; }

  resultadosCotizacion = DB.productos
    .filter(p => productoCoincideTexto(p, q))
    .slice(0,8);

  if (resultadosCotizacion.length===0) { cont.innerHTML='<p style="font-size:13px;color:var(--texto2);padding:8px 0">Sin resultados</p>'; return; }

  renderResultadosCotizacion();
}

function renderResultadosCotizacion() {
  const cont = document.getElementById('cotizacion-resultados');
  cont.innerHTML = `
    <div style="background:var(--card);border:0.5px solid var(--borde);border-radius:12px;overflow:hidden;margin-bottom:1rem;box-shadow:var(--sombra)">
      <div style="padding:8px 12px;background:var(--blush-claro);border-bottom:0.5px solid var(--borde);font-size:11px;color:var(--texto2);font-weight:500;text-transform:uppercase;letter-spacing:0.5px">
        Resultados — ↑↓ para navegar, Enter para agregar
      </div>
      ${resultadosCotizacion.map((p,i) => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:0.5px solid var(--borde);flex-wrap:wrap;gap:8px;${i===indiceCotizacion?'background:var(--rosa-claro)':''}">
          <div>
            ${i===indiceCotizacion?'<span style="font-size:10px;background:var(--rosa);color:#fff;padding:2px 7px;border-radius:10px;margin-right:6px">↵ Enter</span>':''}
            <span style="font-size:14px;font-weight:500">${esc(p.nombre)}</span>
            <div style="font-size:12px;color:var(--texto2)">Código: ${esc(p.ref)} · P1: ${fmt(p.pventa1)}</div>
          </div>
          <button class="btn-primary btn-agregar-cotizacion" data-id="${p.id}" style="flex-shrink:0"><i class="ti ti-plus"></i> Agregar</button>
        </div>`).join('')}
    </div>`;

  cont.querySelectorAll('.btn-agregar-cotizacion').forEach(b =>
    b.addEventListener('click', () => agregarACotizacion(b.dataset.id)));
}

function agregarACotizacion(id) {
  const p = DB.productos.find(x => x.id===id);
  if (!p) return;
  cotizacionProductoActual = p;
  document.getElementById('cq-nombre').textContent = p.nombre;
  document.getElementById('cq-cantidad').value = '1';
  const espCot = precioEspecialCliente(p, clienteCotizacion);
  document.getElementById('cq-precio').value = espCot != null ? espCot : p.pventa1;
  abrirModal('modal-cantidad-cotizacion');
  setTimeout(() => document.getElementById('cq-cantidad').focus(), 100);

  document.getElementById('cotizacion-search').value = '';
  document.getElementById('cotizacion-resultados').innerHTML = '';
}

function confirmarCantidadCotizacion() {
  const cant = parseInt(document.getElementById('cq-cantidad').value) || 0;
  const precio = parseFloat(document.getElementById('cq-precio').value) || 0;
  if (cant < 1) { alert('Ingresa una cantidad válida'); return; }
  if (precio <= 0) { alert('Ingresa un precio válido'); return; }
  const p = cotizacionProductoActual;
  if (!p) return;

  cotizacion.push({ itemId: uid(), codigo: p.ref, nombre: p.nombre, cantidad: cant, precio });
  cerrarModal('modal-cantidad-cotizacion');
  renderCotizacion();
  document.getElementById('cotizacion-search').focus();
  mostrarToast('Producto agregado a la cotización ✓');
}

function eliminarDeCotizacion(itemId) {
  cotizacion = cotizacion.filter(i => i.itemId !== itemId);
  renderCotizacion();
}

function renderCotizacion() {
  const cont = document.getElementById('cotizacion-contenido');
  if (cotizacion.length === 0) {
    cont.innerHTML = `<div class="estado-vacio"><i class="ti ti-file-invoice"></i><p>Sin productos en la cotización.</p></div>`;
    return;
  }

  const totalCotizacion = cotizacion.reduce((acc,i) => acc + i.cantidad*i.precio, 0);

  const filas = cotizacion.map((i, idx) => `
    <tr>
      <td>${idx+1}</td>
      <td><code style="background:var(--blush-claro);padding:2px 7px;border-radius:4px;font-size:12px">${esc(i.codigo)}</code></td>
      <td>${esc(i.nombre)}</td>
      <td style="text-align:center">${i.cantidad}</td>
      <td>${fmt(i.precio)}</td>
      <td>${fmt(i.cantidad*i.precio)}</td>
      <td><button class="btn-peligro btn-quitar-cotizacion" data-id="${i.itemId}" style="padding:5px 9px"><i class="ti ti-trash"></i></button></td>
    </tr>`).join('');

  cont.innerHTML = `
    <div class="tabla-wrap"><table>
    <thead><tr><th>#</th><th>Código</th><th>Nombre</th><th>Cant.</th><th>Precio unit.</th><th>Valor total</th><th></th></tr></thead>
    <tbody>${filas}</tbody></table></div>
    <div style="margin-top:14px;padding:12px 16px;background:var(--rosa-claro);border-radius:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <span style="color:var(--rosa-oscuro);font-weight:500">Total cotización</span>
      <span style="font-size:18px;font-weight:700">${fmt(totalCotizacion)}</span>
    </div>`;

  cont.querySelectorAll('.btn-quitar-cotizacion').forEach(b =>
    b.addEventListener('click', () => eliminarDeCotizacion(b.dataset.id)));
}

function construirHtmlCotizacionPrint(fecha, cliente, items) {
  const total = items.reduce((acc,i) => acc + i.cantidad*i.precio, 0);
  const filas = items.map((i, idx) => `
    <tr>
      <td>${idx+1}</td>
      <td>${esc(i.codigo)}</td>
      <td>${esc(i.nombre)}</td>
      <td style="text-align:center">${i.cantidad}</td>
      <td>${fmt(i.precio)}</td>
      <td>${fmt(i.cantidad*i.precio)}</td>
    </tr>`).join('');

  const nombreCliente = (cliente && cliente.nombre) ? cliente.nombre : 'Consumidor final';

  return `
    <div id="tp-header">
      <h1>Crem Helado</h1>
      <p>WhatsApp: 314 223 8531</p>
      <p style="font-weight:600;margin-top:4px">Cotización</p>
    </div>
    <div id="tp-meta">
      <span><strong>Fecha:</strong> ${fecha}</span>
      <span><strong>Cliente:</strong> ${esc(nombreCliente)}</span>
    </div>
    ${cliente && cliente.cedula ? `<p style="font-size:13px;margin-bottom:4px"><strong>${esc(cliente.tipoDoc||'CC')}:</strong> ${esc(cliente.cedula)}</p>` : ''}
    ${cliente && cliente.telefono ? `<p style="font-size:13px;margin-bottom:4px"><strong>Teléfono:</strong> ${esc(cliente.telefono)}</p>` : ''}
    ${cliente && cliente.direccion ? `<p style="font-size:13px;margin-bottom:4px"><strong>Dirección:</strong> ${esc(cliente.direccion)}</p>` : ''}
    <table>
      <thead><tr><th>#</th><th>Código</th><th>Producto</th><th>Cant.</th><th>Precio unit.</th><th>Valor total</th></tr></thead>
      <tbody>${filas}</tbody>
    </table>
    <p style="margin-top:12px;font-size:15px;text-align:right"><strong>TOTAL: ${fmt(total)}</strong></p>
    <p style="margin-top:20px;font-size:12px;color:#444">Esta cotización es informativa y no constituye una factura de venta. Precios sujetos a cambio sin previo aviso.</p>
  `;
}

function imprimirCotizacion() {
  if (cotizacion.length === 0) { alert('Agrega productos a la cotización antes de imprimir'); return; }
  const nombreLibre = document.getElementById('cot-cliente').value.trim();
  const fecha = fechaCO(new Date());

  const clienteInfo = clienteCotizacion || (nombreLibre ? { nombre: nombreLibre } : null);

  document.getElementById('cotizacion-print-contenido').innerHTML = construirHtmlCotizacionPrint(fecha, clienteInfo, cotizacion);
  prepararImpresion('cotizacion-print');
  window.print();
}

function limpiarCotizacion() {
  if (cotizacion.length === 0) return;
  if (!confirm('¿Vaciar la cotización actual?')) return;
  cotizacion = [];
  document.getElementById('cot-cliente').value = '';
  quitarClienteCotizacion();
  renderCotizacion();
}

// =============================================
// BUSCADOR DE PRODUCTO (widget reutilizable: deudores / anticipos)
// =============================================
function inicializarBuscadorProducto(key, inputId, resultadosId, onSeleccionar) {
  buscadoresProducto[key] = { resultados: [], indice: 0 };
  const input = document.getElementById(inputId);
  const cont = document.getElementById(resultadosId);

  function renderizar() {
    const estado = buscadoresProducto[key];
    cont.innerHTML = `
      <div style="background:var(--card);border:0.5px solid var(--borde);border-radius:12px;overflow:hidden;margin-bottom:1rem;box-shadow:0 4px 16px rgba(31,122,77,0.12)">
        <div style="padding:8px 12px;background:var(--blush-claro);border-bottom:0.5px solid var(--borde);font-size:11px;color:var(--texto2);font-weight:500;text-transform:uppercase;letter-spacing:0.5px">
          Resultados — ↑↓ para navegar, Enter para elegir
        </div>
        ${estado.resultados.map((p,i) => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:0.5px solid var(--borde);flex-wrap:wrap;gap:8px;${i===estado.indice?'background:var(--rosa-claro)':''}">
            <div>
              ${i===estado.indice?'<span style="font-size:10px;background:var(--rosa);color:#fff;padding:2px 7px;border-radius:10px;margin-right:6px">↵ Enter</span>':''}
              <span style="font-size:14px;font-weight:500">${esc(p.nombre)}</span>
              <div style="font-size:12px;color:var(--texto2)">Ref: ${esc(p.ref)} · Stock: ${p.stock} · Precio: ${fmt(p.pventa1)}</div>
            </div>
            <button type="button" class="btn-primary btn-elegir-producto-buscado" data-idx="${i}" style="flex-shrink:0"><i class="ti ti-plus"></i> Elegir</button>
          </div>`).join('')}
      </div>`;
    cont.querySelectorAll('.btn-elegir-producto-buscado').forEach(b =>
      b.addEventListener('click', () => elegir(parseInt(b.dataset.idx))));
  }

  function elegir(i) {
    const p = buscadoresProducto[key].resultados[i];
    if (!p) return;
    input.value = '';
    cont.innerHTML = '';
    buscadoresProducto[key].resultados = [];
    onSeleccionar(p);
  }

  input.addEventListener('input', () => {
    const q = input.value.toLowerCase();
    const estado = buscadoresProducto[key];
    estado.indice = 0;
    if (!q) { cont.innerHTML=''; estado.resultados=[]; return; }
    estado.resultados = DB.productos.filter(p => productoCoincideTexto(p, q)).slice(0,8);
    if (estado.resultados.length===0) { cont.innerHTML = '<p style="font-size:13px;color:var(--texto2);padding:8px 0">Sin resultados</p>'; return; }
    renderizar();
  });

  input.addEventListener('keydown', e => {
    const estado = buscadoresProducto[key];
    if (estado.resultados.length===0) return;
    if (e.key==='ArrowDown') { e.preventDefault(); estado.indice=Math.min(estado.indice+1, estado.resultados.length-1); renderizar(); }
    else if (e.key==='ArrowUp') { e.preventDefault(); estado.indice=Math.max(estado.indice-1,0); renderizar(); }
    else if (e.key==='Enter') { e.preventDefault(); elegir(estado.indice); }
  });
}

// =============================================
// BUSCADOR DE CLIENTE (widget reutilizable: ventas / deudores / anticipos)
// =============================================
function inicializarBuscadorCliente(key, inputId, resultadosId, onSeleccionar) {
  buscadoresCliente[key] = { resultados: [], indice: 0 };
  const input = document.getElementById(inputId);
  const cont = document.getElementById(resultadosId);

  function renderizar() {
    const estado = buscadoresCliente[key];
    cont.innerHTML = `
      <div style="background:var(--card);border:0.5px solid var(--borde);border-radius:12px;overflow:hidden;margin-bottom:1rem;box-shadow:0 4px 16px rgba(23,74,50,0.12)">
        <div style="padding:8px 12px;background:var(--blush-claro);border-bottom:0.5px solid var(--borde);font-size:11px;color:var(--texto2);font-weight:500;text-transform:uppercase;letter-spacing:0.5px">
          Resultados — ↑↓ para navegar, Enter para elegir
        </div>
        ${estado.resultados.map((c,i) => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:0.5px solid var(--borde);flex-wrap:wrap;gap:8px;${i===estado.indice?'background:var(--rosa-claro)':''}">
            <div>
              ${i===estado.indice?'<span style="font-size:10px;background:var(--rosa);color:#fff;padding:2px 7px;border-radius:10px;margin-right:6px">↵ Enter</span>':''}
              <span style="font-size:14px;font-weight:500">${esc(c.nombre)}</span>
              <div style="font-size:12px;color:var(--texto2)">CC ${esc(c.cedula)}${c.telefono?' · Tel: '+esc(c.telefono):''}</div>
            </div>
            <button type="button" class="btn-primary btn-elegir-cliente-buscado" data-idx="${i}" style="flex-shrink:0"><i class="ti ti-plus"></i> Elegir</button>
          </div>`).join('')}
      </div>`;
    cont.querySelectorAll('.btn-elegir-cliente-buscado').forEach(b =>
      b.addEventListener('click', () => elegir(parseInt(b.dataset.idx))));
  }

  function elegir(i) {
    const c = buscadoresCliente[key].resultados[i];
    if (!c) return;
    input.value = '';
    cont.innerHTML = '';
    buscadoresCliente[key].resultados = [];
    onSeleccionar(c);
  }

  input.addEventListener('input', () => {
    const q = input.value.toLowerCase();
    const estado = buscadoresCliente[key];
    estado.indice = 0;
    if (!q) { cont.innerHTML=''; estado.resultados=[]; return; }
    estado.resultados = DB.clientes.filter(c => c.nombre.toLowerCase().includes(q) || c.cedula.toLowerCase().includes(q)).slice(0,8);
    if (estado.resultados.length===0) { cont.innerHTML = '<p style="font-size:13px;color:var(--texto2);padding:8px 0">Sin resultados. Usa "Nuevo cliente" para agregarlo.</p>'; return; }
    renderizar();
  });

  input.addEventListener('keydown', e => {
    const estado = buscadoresCliente[key];
    if (estado.resultados.length===0) return;
    if (e.key==='ArrowDown') { e.preventDefault(); estado.indice=Math.min(estado.indice+1, estado.resultados.length-1); renderizar(); }
    else if (e.key==='ArrowUp') { e.preventDefault(); estado.indice=Math.max(estado.indice-1,0); renderizar(); }
    else if (e.key==='Enter') { e.preventDefault(); elegir(estado.indice); }
  });
}

let editandoClienteId = null;

function abrirModalNuevoCliente(contexto) {
  clienteModalContexto = contexto;
  editandoClienteId = null;
  document.getElementById('modal-cliente-titulo').textContent = 'Nuevo cliente';
  ['cliente-nombre','cliente-cedula','cliente-telefono','cliente-direccion','cliente-correo'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('cliente-tipodoc').value = 'CC';
  abrirModal('modal-cliente');
  setTimeout(() => document.getElementById('cliente-nombre').focus(), 100);
}

function abrirModalEditarCliente(id) {
  const c = DB.clientes.find(x => x.id === id);
  if (!c) return;
  clienteModalContexto = 'clientes';
  editandoClienteId = id;
  document.getElementById('modal-cliente-titulo').textContent = 'Editar cliente';
  document.getElementById('cliente-nombre').value = c.nombre;
  document.getElementById('cliente-cedula').value = c.cedula;
  document.getElementById('cliente-telefono').value = c.telefono || '';
  document.getElementById('cliente-direccion').value = c.direccion || '';
  document.getElementById('cliente-correo').value = c.correo || '';
  document.getElementById('cliente-tipodoc').value = c.tipoDoc || 'CC';
  abrirModal('modal-cliente');
  setTimeout(() => document.getElementById('cliente-nombre').focus(), 100);
}

// =============================================
// PRECIOS ESPECIALES POR CLIENTE
// =============================================
// Cada cliente puede tener una lista de precios propios (producto -> precio).
// Al elegir el cliente en Vender, esos productos salen directamente con su
// precio, sin tener que escogerlo ni escribirlo en cada venta.

function parsearPreciosCliente(v) {
  const arr = parsearJSON(v);
  return Array.isArray(arr)
    ? arr.filter(x => x && x.productoId && Number(x.precio) >= 0).map(x => ({ productoId: String(x.productoId), ref: String(x.ref||''), nombre: String(x.nombre||''), precio: Number(x.precio), publico: Number(x.publico)||0 }))
    : [];
}

// Devuelve el precio especial del cliente para ese producto, o null si no tiene.
function precioEspecialCliente(p, cliente) {
  const c = (cliente === undefined) ? clienteVenta : cliente;
  if (!c || !c.precios || !p) return null;
  const x = c.precios.find(e => e.productoId === p.id);
  return x ? x.precio : null;
}

// =============================================
// PRECIOS POR CLIENTE (sección aparte)
// =============================================
// Cada cliente puede tener su lista fija de productos con dos precios:
// precio de lista (lo que paga) y precio público (lo que él vende, se usa en
// la liquidación de vendedores). Al agregar un producto, los precios arrancan
// con los del inventario y se pueden cambiar.
let preCliente = null;
let preLista = [];

// Entre los dos precios del inventario, el menor es el de lista y el mayor el público.
function preciosPorDefecto(p) {
  const a = Number(p.pventa1) || 0, b = Number(p.pventa2) || 0;
  if (a && b) return { precio: Math.min(a, b), publico: Math.max(a, b) };
  return { precio: a || b, publico: a || b };
}

function mostrarClientePrecios() {
  const box = document.getElementById('pre-cliente-seleccionado');
  const prod = document.getElementById('pre-producto-box');
  if (!preCliente) { box.classList.add('hidden'); prod.classList.add('hidden'); return; }
  document.getElementById('pre-cliente-nombre').textContent = preCliente.nombre;
  document.getElementById('pre-cliente-detalle').textContent = `${preCliente.tipoDoc || 'CC'} ${preCliente.cedula}${preCliente.telefono ? ' · Tel: ' + preCliente.telefono : ''}`;
  box.classList.remove('hidden');
  prod.classList.remove('hidden');
}

function seleccionarClientePrecios(c) {
  preCliente = c;
  preLista = (c.precios || []).map(x => ({ ...x }));
  mostrarClientePrecios();
  renderPreciosEditor();
  setTimeout(() => { const i = document.getElementById('pre-producto-buscar'); if (i) i.focus(); }, 100);
}

function quitarClientePrecios() {
  preCliente = null; preLista = [];
  mostrarClientePrecios();
  renderPreciosEditor();
}

function agregarProductoPrecios(p) {
  if (!preCliente) { alert('Primero elige el cliente.'); return; }
  let i = preLista.findIndex(x => x.productoId === p.id);
  if (i < 0) {
    preLista.push({ productoId: p.id, ref: p.ref, nombre: p.nombre, ...preciosPorDefecto(p) });
    i = preLista.length - 1;
  }
  renderPreciosEditor();
  setTimeout(() => {
    const inp = document.querySelector(`#pre-editor tr[data-i="${i}"] .pre-in`);
    if (inp) { inp.focus(); inp.select(); }
  }, 50);
}

function renderPreciosEditor() {
  const cont = document.getElementById('pre-editor');
  if (!cont) return;
  if (!preCliente) {
    cont.innerHTML = `<div class="estado-vacio"><i class="ti ti-tags"></i><p>Busca un cliente para ver y editar sus precios.</p></div>`;
    return;
  }
  if (preLista.length === 0) {
    cont.innerHTML = `<p style="font-size:13px;color:var(--texto2);margin:10px 0">Este cliente todavía no tiene precios. Busca un producto arriba para agregarlo.</p>`;
  } else {
    const filas = preLista.map((x, i) => `
      <tr data-i="${i}">
        <td>${esc(x.nombre)}<div style="font-size:11px;color:var(--texto2)">${esc(x.ref || '')}</div></td>
        <td><input type="number" min="0" class="pre-in" data-i="${i}" data-f="precio" value="${x.precio || ''}" placeholder="0" style="width:110px"></td>
        <td><input type="number" min="0" class="pre-in" data-i="${i}" data-f="publico" value="${x.publico || ''}" placeholder="0" style="width:110px"></td>
        <td><button type="button" class="btn-peligro btn-quitar-pre" data-i="${i}" style="padding:5px 9px"><i class="ti ti-trash"></i></button></td>
      </tr>`).join('');
    cont.innerHTML = `
      <div class="tabla-wrap"><table class="pre-tabla">
        <thead><tr><th>Producto</th><th>Precio de lista (lo que paga)</th><th>Precio público (lo que vende)</th><th></th></tr></thead>
        <tbody>${filas}</tbody>
      </table></div>`;
  }
  cont.innerHTML += `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:1rem">
      <button class="btn-primary" id="btn-pre-guardar"><i class="ti ti-device-floppy"></i> Guardar precios</button>
    </div>`;

  const entradas = Array.from(cont.querySelectorAll('.pre-in'));
  entradas.forEach((el, idx) => {
    el.addEventListener('input', () => { preLista[parseInt(el.dataset.i)][el.dataset.f] = parseFloat(el.value) || 0; });
    el.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const sig = entradas[idx + 1];
      if (sig) { sig.focus(); sig.select(); }
      else document.getElementById('pre-producto-buscar').focus();
    });
  });
  cont.querySelectorAll('.btn-quitar-pre').forEach(b => b.addEventListener('click', () => {
    preLista.splice(parseInt(b.dataset.i), 1);
    renderPreciosEditor();
  }));
  document.getElementById('btn-pre-guardar').addEventListener('click', guardarPreciosCliente);
}

async function guardarPreciosCliente() {
  if (!preCliente) return;
  const c = DB.clientes.find(x => x.id === preCliente.id);
  if (!c) { alert('Este cliente ya no existe.'); return; }
  const sinPrecio = preLista.filter(x => !(Number(x.precio) > 0));
  if (sinPrecio.length && !confirm(`${sinPrecio.length} producto(s) no tienen precio de lista (${sinPrecio.map(x => x.nombre).join(', ')}). ¿Guardar así?`)) return;
  c.precios = preLista.map(x => ({
    productoId: x.productoId, ref: x.ref || '', nombre: x.nombre || '',
    precio: Number(x.precio) || 0, publico: Number(x.publico) || 0
  }));
  const ok = await sheetsEscribir('update', 'Clientes', [c.id, c.nombre, c.cedula, c.telefono, c.direccion, c.correo, c.tipoDoc, JSON.stringify(c.precios)], c.id);
  guardarLocal();
  if (!ok) { alert('NO SE PUDIERON GUARDAR LOS PRECIOS en Google Sheets. Revisa la conexión e inténtalo de nuevo.'); return; }
  preCliente = c;
  if (clienteVenta && clienteVenta.id === c.id) seleccionarClienteVenta(c);
  mostrarToast('Precios guardados ✓');
}

// Re-calcula el carrito cuando se elige o se quita el cliente.
function aplicarPreciosClienteACarrito() {
  carrito.forEach(item => {
    const p = DB.productos.find(x => x.id === item.id);
    const esp = precioEspecialCliente(p);
    if (esp != null) {
      item.precio = esp; item.precioCliente = true;
    } else if (item.precioCliente) {
      item.precio = item.pventa1; item.precioCliente = false;
    }
    item.total = item.cantidad * item.precio;
  });
  // unir renglones repetidos del mismo producto al mismo precio
  const unidos = [];
  carrito.forEach(item => {
    const igual = unidos.find(u => u.id === item.id && u.precio === item.precio);
    if (igual) { igual.cantidad += item.cantidad; igual.total = igual.cantidad * igual.precio; }
    else unidos.push(item);
  });
  carrito = unidos;
  renderCarrito();
}

// Botones rápidos con los productos que tienen precio especial para el cliente.
function renderAtajosPreciosCliente() {
  const cont = document.getElementById('venta-cliente-atajos');
  if (!cont) return;
  if (!clienteVenta || !clienteVenta.precios || clienteVenta.precios.length === 0) {
    cont.innerHTML = ''; cont.classList.add('hidden'); return;
  }
  cont.classList.remove('hidden');
  cont.innerHTML = `
    <div style="font-size:11px;color:var(--texto2);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Precios de ${esc(clienteVenta.nombre)} — toca para agregar</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px">
      ${clienteVenta.precios.map(x => `<button type="button" class="btn-secundario btn-atajo-cliente" data-id="${x.productoId}" style="padding:6px 10px">${esc(x.nombre)} · <strong>${fmt(x.precio)}</strong></button>`).join('')}
    </div>`;
  cont.querySelectorAll('.btn-atajo-cliente').forEach(b => b.addEventListener('click', () => abrirFlujRapido(b.dataset.id)));
}

async function guardarCliente() {
  const nombre = document.getElementById('cliente-nombre').value.trim();
  const cedula = document.getElementById('cliente-cedula').value.trim();
  const telefono = document.getElementById('cliente-telefono').value.trim();
  const direccion = document.getElementById('cliente-direccion').value.trim();
  const correo = document.getElementById('cliente-correo').value.trim();
  const tipoDoc = document.getElementById('cliente-tipodoc').value;
  if (!nombre || !cedula) { alert('Completa nombre y cédula del cliente'); return; }

  if (editandoClienteId) {
    const c = DB.clientes.find(x => x.id === editandoClienteId);
    if (c) {
      Object.assign(c, { nombre, cedula, telefono, direccion, correo, tipoDoc, precios: c.precios || [] });
      await sheetsEscribir('update','Clientes',[c.id,c.nombre,c.cedula,c.telefono,c.direccion,c.correo,c.tipoDoc,JSON.stringify(c.precios)],c.id);
      if (clienteVenta && clienteVenta.id === c.id) seleccionarClienteVenta(c);
    }
    guardarLocal();
    cerrarModal('modal-cliente');
    mostrarToast('Cliente actualizado ✓');
    editandoClienteId = null;
    renderClientes();
    return;
  }

  const nuevo = { id: uid(), nombre, cedula, telefono, direccion, correo, tipoDoc, precios: [] };
  DB.clientes.push(nuevo);
  await sheetsEscribir('append','Clientes',[nuevo.id,nuevo.nombre,nuevo.cedula,nuevo.telefono,nuevo.direccion,nuevo.correo,nuevo.tipoDoc,JSON.stringify(nuevo.precios)]);
  guardarLocal();
  cerrarModal('modal-cliente');
  mostrarToast('Cliente agregado ✓');

  if (clienteModalContexto === 'venta') seleccionarClienteVenta(nuevo);
  else if (clienteModalContexto === 'deudor') seleccionarClienteDeudor(nuevo);
  else if (clienteModalContexto === 'anticipo') seleccionarClienteAnticipo(nuevo);
  else if (clienteModalContexto === 'clientes') renderClientes();
  clienteModalContexto = null;
}

async function eliminarCliente(id) {
  if (!confirm('¿Eliminar este cliente? (No borra sus ventas anteriores)')) return;
  await sheetsEscribir('delete','Clientes',null,id);
  DB.clientes = DB.clientes.filter(c => c.id !== id);
  guardarLocal();
  renderClientes();
  mostrarToast('Cliente eliminado');
}

function renderClientes() {
  const cont = document.getElementById('clientes-contenido');
  if (!cont) return;
  const q = (document.getElementById('clientes-search')?.value || '').toLowerCase();
  const lista = DB.clientes.filter(c => !q || c.nombre.toLowerCase().includes(q) || c.cedula.toLowerCase().includes(q));

  if (lista.length === 0) {
    cont.innerHTML = `<div class="estado-vacio"><i class="ti ti-users"></i><p>Sin clientes registrados.</p></div>`;
    return;
  }

  const filas = lista.map(c => `
    <tr>
      <td>${esc(c.nombre)}</td>
      <td><span class="badge rosa">${esc(c.tipoDoc||'CC')}</span> ${esc(c.cedula)}</td>
      <td style="font-size:13px">${esc(c.telefono)||'-'}</td>
      <td style="font-size:13px">${esc(c.direccion)||'-'}</td>
      <td style="font-size:13px">${esc(c.correo)||'-'}</td>
      <td style="font-size:13px">${(c.precios&&c.precios.length)?`<span class="badge rosa">${c.precios.length} precio${c.precios.length>1?'s':''}</span>`:'-'}</td>
      <td><div style="display:flex;gap:6px">
        <button class="btn-secundario btn-precios-cliente" data-id="${c.id}" style="padding:6px 10px" title="Precios de este cliente"><i class="ti ti-tags"></i></button>
        <button class="btn-secundario btn-editar-cliente" data-id="${c.id}" style="padding:6px 10px"><i class="ti ti-edit"></i></button>
        <button class="btn-peligro btn-eliminar-cliente" data-id="${c.id}" style="padding:6px 10px"><i class="ti ti-trash"></i></button>
      </div></td>
    </tr>`).join('');

  cont.innerHTML = `<div class="tabla-wrap"><table>
    <thead><tr><th>Nombre</th><th>Documento</th><th>Teléfono</th><th>Dirección</th><th>Correo</th><th>Precios esp.</th><th>Acciones</th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;

  cont.querySelectorAll('.btn-precios-cliente').forEach(b => b.addEventListener('click', () => {
    const c = DB.clientes.find(x => x.id === b.dataset.id);
    if (!c) return;
    mostrarPanel('precios');
    seleccionarClientePrecios(c);
  }));
  cont.querySelectorAll('.btn-editar-cliente').forEach(b => b.addEventListener('click', () => abrirModalEditarCliente(b.dataset.id)));
  cont.querySelectorAll('.btn-eliminar-cliente').forEach(b => b.addEventListener('click', () => eliminarCliente(b.dataset.id)));
}

function seleccionarClienteVenta(c) {
  clienteVenta = c;
  document.getElementById('venta-cliente-nombre').textContent = c.nombre;
  document.getElementById('venta-cliente-detalle').textContent = `CC ${c.cedula}${c.telefono?' · Tel: '+c.telefono:''}`;
  document.getElementById('venta-cliente-seleccionado').classList.remove('hidden');
  document.getElementById('venta-cliente-buscar').value = '';
  document.getElementById('venta-cliente-resultados').innerHTML = '';
  aplicarPreciosClienteACarrito();
  renderAtajosPreciosCliente();
}

function quitarClienteVenta() {
  clienteVenta = null;
  document.getElementById('venta-cliente-seleccionado').classList.add('hidden');
  aplicarPreciosClienteACarrito();
  renderAtajosPreciosCliente();
}

function seleccionarClienteCotizacion(c) {
  clienteCotizacion = c;
  document.getElementById('cotizacion-cliente-nombre').textContent = c.nombre;
  document.getElementById('cotizacion-cliente-detalle').textContent = `${c.tipoDoc||'CC'} ${c.cedula}${c.telefono?' · Tel: '+c.telefono:''}`;
  document.getElementById('cotizacion-cliente-seleccionado').classList.remove('hidden');
  document.getElementById('cotizacion-cliente-buscar').value = '';
  document.getElementById('cotizacion-cliente-resultados').innerHTML = '';
  document.getElementById('cot-cliente').value = '';
}

function quitarClienteCotizacion() {
  clienteCotizacion = null;
  document.getElementById('cotizacion-cliente-seleccionado').classList.add('hidden');
}

function seleccionarClienteDeudor(c) {
  clienteDeudor = c;
  document.getElementById('deudor-cliente-nombre').textContent = c.nombre;
  document.getElementById('deudor-cliente-detalle').textContent = `CC ${c.cedula}${c.telefono?' · Tel: '+c.telefono:''}`;
  document.getElementById('deudor-cliente-seleccionado').classList.remove('hidden');
  document.getElementById('deudor-cliente-buscar').value = '';
  document.getElementById('deudor-cliente-resultados').innerHTML = '';
}

function quitarClienteDeudor() {
  clienteDeudor = null;
  document.getElementById('deudor-cliente-seleccionado').classList.add('hidden');
}

function seleccionarClienteAnticipo(c) {
  clienteAnticipo = c;
  document.getElementById('anticipo-cliente-nombre').textContent = c.nombre;
  document.getElementById('anticipo-cliente-detalle').textContent = `CC ${c.cedula}${c.telefono?' · Tel: '+c.telefono:''}`;
  document.getElementById('anticipo-cliente-seleccionado').classList.remove('hidden');
  document.getElementById('anticipo-cliente-buscar').value = '';
  document.getElementById('anticipo-cliente-resultados').innerHTML = '';
}

function quitarClienteAnticipo() {
  clienteAnticipo = null;
  document.getElementById('anticipo-cliente-seleccionado').classList.add('hidden');
}

// =============================================
// DEUDAS / ANTICIPOS — utilidades comunes
// =============================================
function calcularAbonado(d) {
  const abonos = Array.isArray(d.abonos) ? d.abonos : [];
  return abonos.reduce((a, x) => a + (Number(x.monto) || 0), 0);
}

function calcularSaldo(d) {
  return Math.max(0, (Number(d.monto) || 0) - calcularAbonado(d));
}
function deudaVencida(d) {
  if (!d.fechaLimite || calcularSaldo(d) <= 0) return false;
  const hoy = new Date(); hoy.setHours(0,0,0,0);
  return parseFechaCO(d.fechaLimite) < hoy;
}

// Registra un pago (anticipo o abono) contra una deuda/anticipo: queda como abono
// Y ADEMÁS entra a la caja del día como una venta más (efectivo o transferencia).
async function registrarPagoDeuda(entidad, tipo, monto, metodoPago) {
  const ahora = new Date();
  entidad.abonos = entidad.abonos || [];
  entidad.abonos.push({ id: uid(), monto, metodoPago, fecha: fechaCO(ahora), hora: horaCO(ahora) });

  const productos = entidad.productos || [];
  let costoTotal = 0;
  productos.forEach(pr => {
    const p = DB.productos.find(x => x.id===pr.productoId);
    if (p) costoTotal += p.pcompra * (pr.cantidad||0);
  });
  const gananciaTotal = entidad.monto - costoTotal;
  const gananciaPago = entidad.monto>0 ? monto * (gananciaTotal/entidad.monto) : 0;
  const etiqueta = tipo==='deudor' ? 'Abono deuda' : 'Anticipo';
  const nombresProductos = productos.map(p=>p.productoNombre).join(', ');

  const itemsBoucher = productos.length
    ? productos.map(pr => ({ ref: pr.ref||'-', nombre: pr.productoNombre, cantidad: pr.cantidad, precio: pr.precioUnit, total: pr.precioUnit*pr.cantidad }))
    : [{ ref:'-', nombre: etiqueta, cantidad:1, precio: monto, total: monto }];

  const venta = {
    id: uid(), fecha: fechaCO(ahora), hora: horaCO(ahora),
    total: monto, ganancia: gananciaPago,
    nota: nombresProductos ? `${etiqueta} de: ${nombresProductos}` : etiqueta,
    metodoPago,
    items: itemsBoucher,
    clienteId: entidad.clienteId||'', clienteNombre: entidad.nombre||'',
    clienteCedula: entidad.cedula||'', clienteTelefono: entidad.telefono||'',
    clienteDireccion: entidad.direccion||'',
    pagadoAhora: monto,
    saldoPendiente: calcularSaldo(entidad)
  };
  DB.ventas.push(venta);
  const ventaGuardada = await sheetsEscribir('append','Ventas',[venta.id,venta.fecha,venta.hora,venta.total,venta.ganancia,venta.nota,venta.metodoPago,JSON.stringify(venta.items),venta.clienteId,venta.clienteNombre,venta.clienteCedula,venta.clienteTelefono,venta.clienteDireccion,venta.pagadoAhora,venta.saldoPendiente]);
  if (!ventaGuardada) {
    DB.ventas = DB.ventas.filter(v => v.id !== venta.id);
    entidad.abonos.pop();
    throw new Error('No se pudo guardar el movimiento del abono en la hoja Ventas.');
  }

  entidad.pagada = calcularSaldo(entidad) <= 0;

  if (tipo==='anticipo' && entidad.pagada && productos.length && !entidad.descontado) {
    for (const pr of productos) {
      const p = DB.productos.find(x => x.id===pr.productoId);
      if (p) {
        p.stock = Math.max(0, p.stock - (pr.cantidad||0));
        await sheetsEscribir('update','Productos',[p.id,p.ref,p.nombre,p.pcompra,p.pventa1,p.pventa2,p.stock],p.id);
      }
    }
    entidad.descontado = true;
  }

  return venta;
}

function imprimirBoucherDeuda(d, tipo) {
  const ahora = new Date();
  const abonos = d.abonos||[];
  const saldo = calcularSaldo(d);
  const titulo = tipo==='deudor' ? 'Comprobante de deuda' : 'Comprobante de anticipo';

  const filasAbonos = abonos.map((a,i) => `
    <tr>
      <td>${i+1}</td>
      <td>${a.fecha} ${a.hora}</td>
      <td>${a.metodoPago==='transferencia'?'Transferencia':'Efectivo'}</td>
      <td style="text-align:right">${fmt(a.monto)}</td>
    </tr>`).join('');

  const productos = d.productos||[];
  const filasProductos = productos.map(p => `
    <tr>
      <td>${esc(p.ref||'-')}</td>
      <td>${esc(p.productoNombre)}</td>
      <td style="text-align:center">${p.cantidad}</td>
      <td style="text-align:right">${fmt(p.precioUnit)}</td>
    </tr>`).join('');

  document.getElementById('deudor-print-contenido').innerHTML = `
    <div id="tp-header">
      <h1>Crem Helado</h1>
      <p>${titulo}</p>
    </div>
    <div id="tp-meta">
      <span><strong>Fecha:</strong> ${fechaCO(ahora)}</span>
      <span><strong>Hora:</strong> ${horaCO(ahora)}</span>
    </div>
    <p style="font-size:13px;margin-bottom:4px"><strong>Cliente:</strong> ${esc(d.nombre)}</p>
    <p style="font-size:13px;margin-bottom:4px"><strong>Cédula:</strong> ${esc(d.cedula)}</p>
    ${d.telefono?`<p style="font-size:13px;margin-bottom:4px"><strong>Teléfono:</strong> ${esc(d.telefono)}</p>`:''}
    ${d.direccion?`<p style="font-size:13px;margin-bottom:4px"><strong>Dirección:</strong> ${esc(d.direccion)}</p>`:''}
    ${productos.length?`
      <table style="margin-top:8px;margin-bottom:8px">
        <thead><tr><th>Código</th><th>Producto</th><th>Cant.</th><th>Precio</th></tr></thead>
        <tbody>${filasProductos}</tbody>
      </table>`:''}
    ${d.nota?`<p style="font-size:13px;margin-bottom:4px"><strong>Comentario:</strong> ${esc(d.nota)}</p>`:''}
    ${d.fechaLimite?`<p style="font-size:13px;margin-bottom:12px"><strong>Fecha límite de pago:</strong> ${d.fechaLimite}</p>`:''}
    <p style="margin-top:8px;font-size:14px"><strong>Monto total: ${fmt(d.monto)}</strong></p>
    ${abonos.length?`
      <p style="margin-top:12px;font-size:13px"><strong>${tipo==='deudor'?'Abonos realizados':'Anticipos realizados'}:</strong></p>
      <table>
        <thead><tr><th>#</th><th>Fecha</th><th>Método</th><th>Monto</th></tr></thead>
        <tbody>${filasAbonos}</tbody>
      </table>`:''}
    <p style="margin-top:12px;font-size:16px"><strong>Saldo pendiente: ${fmt(saldo)}</strong></p>
    ${saldo<=0?`<p style="text-align:center;margin-top:8px;font-size:13px">${tipo==='deudor'?'DEUDA CANCELADA EN SU TOTALIDAD':'ANTICIPO CANCELADO — PRODUCTO ENTREGADO'}</p>`:''}
  `;

  prepararImpresion('deudor-print');
  window.print();
}

// Modal genérico para registrar un pago posterior (usado por deudores y anticipos)
function abrirModalAbono(id, tipo) {
  deudorAbonoActual = id;
  tipoAbonoActual = tipo;
  const lista = tipo==='deudor' ? DB.deudores : DB.anticipos;
  const d = lista.find(x => x.id===id);
  if (!d) return;
  document.getElementById('abono-nombre').textContent = d.nombre;
  document.getElementById('abono-saldo').textContent = `Saldo pendiente: ${fmt(calcularSaldo(d))}`;
  document.getElementById('abono-monto').value = '';
  document.querySelector('input[name="abono-metodo"][value="efectivo"]').checked = true;
  abrirModal('modal-abono');
  setTimeout(() => document.getElementById('abono-monto').focus(), 100);
}

async function guardarAbono() {
  const lista = tipoAbonoActual==='deudor' ? DB.deudores : DB.anticipos;
  const d = lista.find(x => x.id===deudorAbonoActual);
  if (!d) return;

  const monto = parseFloat(document.getElementById('abono-monto').value)||0;
  const saldo = calcularSaldo(d);
  if (!monto || monto<=0) { alert('Ingresa un monto válido'); return; }
  if (monto > saldo) { alert(`El abono no puede ser mayor al saldo pendiente (${fmt(saldo)})`); return; }

  const metodoSeleccionado = document.querySelector('input[name="abono-metodo"]:checked');
  if (!metodoSeleccionado) { alert('Selecciona el método de pago'); return; }
  const metodoPago = metodoSeleccionado.value;

  const abonosAnteriores = Array.isArray(d.abonos) ? d.abonos.map(a => ({...a})) : [];
  const pagadaAnterior = !!d.pagada;
  let ventaAbono = null;
  const btnAbono = document.getElementById('btn-guardar-abono');
  if (btnAbono && btnAbono.disabled) return;
  if (btnAbono) { btnAbono.disabled = true; btnAbono.textContent = 'Guardando...'; }

  try {
    ventaAbono = await registrarPagoDeuda(d, tipoAbonoActual, monto, metodoPago);

    const guardadoEntidad = tipoAbonoActual==='deudor'
      ? await guardarDeudorEnSheet(d, false)
      : await guardarAnticipoEnSheet(d, false);

    if (!guardadoEntidad) {
      if (ventaAbono) await sheetsEscribir('delete','Ventas',null,ventaAbono.id);
      d.abonos = abonosAnteriores;
      d.pagada = pagadaAnterior;
      if (ventaAbono) DB.ventas = DB.ventas.filter(v => v.id !== ventaAbono.id);
      throw new Error('Google Sheets no confirmó la actualización del registro.');
    }

    guardarLocal();
    cerrarModal('modal-abono');
    if (tipoAbonoActual==='deudor') renderDeudores();
    else renderAnticipos();
    renderDashboard();

    const completado = calcularSaldo(d)<=0;
    mostrarToast(completado
      ? (tipoAbonoActual==='deudor'?'Deuda pagada completamente ✓':'Anticipo pagado completamente ✓')
      : `Abono guardado ✓ · ${fmt(monto)}`);
  } catch (e) {
    d.abonos = abonosAnteriores;
    d.pagada = pagadaAnterior;
    if (ventaAbono) DB.ventas = DB.ventas.filter(v => v.id !== ventaAbono.id);
    guardarLocal();
    console.error('Error guardando abono:', e);
    alert('NO SE PUDO GUARDAR EL ABONO.\n\n' + (e && e.message ? e.message : String(e)));
  } finally {
    if (btnAbono) { btnAbono.disabled = false; btnAbono.textContent = 'Registrar abono'; }
  }
}

// =============================================
// DEUDORES (el cliente ya se lleva el producto)
// =============================================
function agregarProductoDeudor(p) {
  const existente = productosDeudor.find(x=>x.productoId===p.id);
  if (existente) {
    if (existente.cantidad >= p.stock) { alert(`Solo hay ${p.stock} unidades disponibles de ${p.nombre}.`); return; }
    existente.cantidad += 1;
  } else {
    if (p.stock < 1) { alert('Sin stock disponible de este producto.'); return; }
    productosDeudor.push({ productoId: p.id, ref: p.ref, nombre: p.nombre, cantidad: 1, precioUnit: p.pventa1 });
  }
  renderProductosDeudor();
  recalcularMontoDeudor();
}

function recalcularMontoDeudor() {
  const total = productosDeudor.reduce((a,p)=>a+p.precioUnit*p.cantidad,0);
  if (total>0) document.getElementById('deudor-monto').value = total;
}

function renderProductosDeudor() {
  const cont = document.getElementById('deudor-productos-lista');
  if (productosDeudor.length === 0) { cont.innerHTML = ''; return; }
  cont.innerHTML = productosDeudor.map((item,idx) => `
    <div class="carrito-item">
      <div class="item-nombre">
        <strong>${esc(item.nombre)}</strong>
        <span>Ref: ${esc(item.ref)}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <input type="number" value="${item.cantidad}" min="1" class="input-cantidad-deudor" data-idx="${idx}">
        <span class="item-total">${fmt(item.precioUnit*item.cantidad)}</span>
        <button type="button" class="btn-peligro btn-quitar-producto-deudor-item" data-idx="${idx}" style="padding:6px 10px"><i class="ti ti-x"></i></button>
      </div>
    </div>`).join('');

  cont.querySelectorAll('.input-cantidad-deudor').forEach(input => {
    input.addEventListener('change', () => {
      const idx = parseInt(input.dataset.idx);
      const item = productosDeudor[idx];
      const p = DB.productos.find(x=>x.id===item.productoId);
      let nuevaCant = Math.max(1, parseInt(input.value)||1);
      if (p && nuevaCant > p.stock) {
        alert(`Solo hay ${p.stock} unidades disponibles de ${item.nombre}.`);
        nuevaCant = p.stock > 0 ? p.stock : 1;
      }
      item.cantidad = nuevaCant;
      renderProductosDeudor();
      recalcularMontoDeudor();
    });
  });
  cont.querySelectorAll('.btn-quitar-producto-deudor-item').forEach(b =>
    b.addEventListener('click', () => {
      productosDeudor.splice(parseInt(b.dataset.idx),1);
      renderProductosDeudor();
      recalcularMontoDeudor();
    }));
}

async function guardarDeudorEnSheet(d, esNuevo) {
  const fila = [d.id,d.clienteId,d.nombre,d.cedula,d.telefono,d.direccion,JSON.stringify(d.productos||[]),d.monto,d.nota,d.fecha,d.hora,d.fechaLimite,JSON.stringify(d.abonos),d.pagada];
  if (esNuevo) return await sheetsEscribir('append','Deudores',fila);
  return await sheetsEscribir('update','Deudores',fila,d.id);
}

function abrirModalDeudor(id) {
  editandoDeudorId = id || null;
  productosDeudor = [];
  document.getElementById('deudor-producto-buscar').value = '';
  document.getElementById('deudor-producto-resultados').innerHTML = '';
  document.getElementById('deudor-anticipo').value = '';
  document.querySelector('input[name="deudor-metodo"][value="efectivo"]').checked = true;
  quitarClienteDeudor();
  document.getElementById('deudor-cliente-buscar').value = '';
  document.getElementById('deudor-cliente-resultados').innerHTML = '';
  document.getElementById('modal-deudor-titulo').textContent = id ? 'Editar deudor' : 'Agregar deudor';
  if (id) {
    const d = DB.deudores.find(x => x.id === id);
    if (!d) return;
    seleccionarClienteDeudor({ id: d.clienteId, nombre: d.nombre, cedula: d.cedula, telefono: d.telefono });
    productosDeudor = (d.productos||[]).map(p=>({productoId:p.productoId, ref:p.ref||'', nombre:p.productoNombre, cantidad:p.cantidad, precioUnit:p.precioUnit}));
    document.getElementById('deudor-monto').value = d.monto;
    document.getElementById('deudor-nota').value = d.nota||'';
    document.getElementById('deudor-fecha-limite').value = coAIso(d.fechaLimite);
  } else {
    ['deudor-monto','deudor-nota','deudor-fecha-limite'].forEach(x => document.getElementById(x).value='');
  }
  renderProductosDeudor();
  abrirModal('modal-deudor');
}

async function guardarDeudor() {
  const monto = parseFloat(document.getElementById('deudor-monto').value)||0;
  const nota = document.getElementById('deudor-nota').value.trim();
  const fechaLimiteISO = document.getElementById('deudor-fecha-limite').value;
  if (!clienteDeudor||!monto) { alert('Selecciona un cliente e ingresa el monto de la deuda'); return; }
  for (const item of productosDeudor) {
    const p = DB.productos.find(x => x.id===item.productoId);
    if (p && item.cantidad > p.stock) { alert(`Solo hay ${p.stock} unidades disponibles de ${item.nombre}.`); return; }
  }

  const fechaLimite = fechaLimiteISO ? isoAFechaCO(fechaLimiteISO) : '';
  const btn = document.getElementById('btn-guardar-deudor');
  btn.textContent='Guardando...'; btn.disabled=true;
  const productos = productosDeudor.map(p=>({productoId:p.productoId, ref:p.ref, productoNombre:p.nombre, cantidad:p.cantidad, precioUnit:p.precioUnit}));

  if (editandoDeudorId) {
    const d = DB.deudores.find(x => x.id===editandoDeudorId);
    if (d) {
      Object.assign(d, {
        clienteId: clienteDeudor.id, nombre: clienteDeudor.nombre, cedula: clienteDeudor.cedula,
        telefono: clienteDeudor.telefono||'', nota, productos, monto, fechaLimite
      });
      d.pagada = calcularSaldo(d) <= 0;
      const actualizado = await guardarDeudorEnSheet(d, false);
      if (!actualizado) {
        btn.textContent='Guardar'; btn.disabled=false;
        alert('NO SE PUDO ACTUALIZAR EL DEUDOR EN GOOGLE SHEETS.\n\nNo se cerró el formulario para que puedas volver a intentarlo.');
        return;
      }
    }
    btn.textContent='Guardar'; btn.disabled=false;
    guardarLocal(); cerrarModal('modal-deudor'); renderDeudores();
    mostrarToast('Deudor actualizado ✓');
    return;
  }

  const anticipo = parseFloat(document.getElementById('deudor-anticipo').value)||0;
  const metodoPago = document.querySelector('input[name="deudor-metodo"]:checked').value;
  if (anticipo > monto) { alert('El pago inicial no puede ser mayor al monto total de la deuda'); return; }

  // El cliente se lleva los productos de una vez: se descuenta el inventario ya
  for (const item of productosDeudor) {
    const p = DB.productos.find(x => x.id===item.productoId);
    if (p) {
      p.stock = Math.max(0, p.stock - item.cantidad);
      await sheetsEscribir('update','Productos',[p.id,p.ref,p.nombre,p.pcompra,p.pventa1,p.pventa2,p.stock],p.id);
    }
  }

  const ahora = new Date();
  const nuevo = {
    id: uid(), clienteId: clienteDeudor.id, nombre: clienteDeudor.nombre, cedula: clienteDeudor.cedula,
    telefono: clienteDeudor.telefono||'', direccion: clienteDeudor.direccion||'',
    productos,
    monto, nota, fecha: fechaCO(ahora), hora: horaCO(ahora), fechaLimite,
    abonos: [], pagada: false
  };
  DB.deudores.push(nuevo);
  const deudorGuardado = await guardarDeudorEnSheet(nuevo, true);
  if (!deudorGuardado) {
    DB.deudores = DB.deudores.filter(x => x.id !== nuevo.id);
    btn.textContent='Guardar'; btn.disabled=false;
    alert('NO SE PUDO GUARDAR EL DEUDOR EN GOOGLE SHEETS.\n\nRevisa la conexión y vuelve a intentarlo.');
    return;
  }

  if (anticipo > 0) {
    try {
      const ventaInicial = await registrarPagoDeuda(nuevo, 'deudor', anticipo, metodoPago);
      const deudorActualizado = await guardarDeudorEnSheet(nuevo, false);
      if (!deudorActualizado) {
        if (ventaInicial) await sheetsEscribir('delete','Ventas',null,ventaInicial.id);
        DB.ventas = DB.ventas.filter(v => !ventaInicial || v.id !== ventaInicial.id);
        DB.deudores = DB.deudores.filter(x => x.id !== nuevo.id);
        alert('NO SE PUDO GUARDAR EL ABONO INICIAL DEL DEUDOR.\n\nEl registro fue revertido para evitar inconsistencias.');
        btn.textContent='Guardar'; btn.disabled=false;
        return;
      }
    } catch (e) {
      DB.deudores = DB.deudores.filter(x => x.id !== nuevo.id);
      console.error('Error guardando abono inicial:', e);
      alert('NO SE PUDO GUARDAR EL ABONO INICIAL.\n\n' + (e && e.message ? e.message : String(e)));
      btn.textContent='Guardar'; btn.disabled=false;
      return;
    }
  }

  guardarLocal(); btn.textContent='Guardar'; btn.disabled=false;
  cerrarModal('modal-deudor'); renderDeudores(); renderDashboard();
  mostrarToast('Deudor agregado ✓ (usa el botón de imprimir para el boucher)');
}

async function eliminarDeudor(id) {
  if (!confirm('¿Eliminar este deudor?')) return;
  await sheetsEscribir('delete','Deudores',null,id);
  DB.deudores = DB.deudores.filter(d => d.id!==id);
  guardarLocal(); renderDeudores(); mostrarToast('Deudor eliminado');
}

function renderDeudores() {
  const cont = document.getElementById('deudores-contenido');
  if (DB.deudores.length === 0) {
    cont.innerHTML = `<div class="estado-vacio"><i class="ti ti-users"></i><p>Sin deudores registrados.</p></div>`;
    return;
  }

  const ordenados = DB.deudores.slice().sort((a,b) => (calcularSaldo(b)>0?1:0) - (calcularSaldo(a)>0?1:0));

  const filas = ordenados.map(d => {
    const saldo = calcularSaldo(d);
    const abonado = calcularAbonado(d);
    const vencida = deudaVencida(d);
    const badge = saldo<=0 ? '<span class="badge ok">Pagada</span>'
      : vencida ? '<span class="badge danger">Vencida</span>'
      : '<span class="badge alerta">Pendiente</span>';
    return `<tr>
      <td>${esc(d.nombre)}<div style="font-size:11px;color:var(--texto2)">CC ${esc(d.cedula)}</div></td>
      <td style="font-size:13px">${d.productos&&d.productos.length?d.productos.map(p=>esc(p.productoNombre)+' x'+p.cantidad).join(', '):'-'}</td>
      <td>${fmt(d.monto)}</td>
      <td>${fmt(abonado)}</td>
      <td style="font-weight:500">${fmt(saldo)}</td>
      <td style="font-size:13px">${d.fechaLimite||'-'}</td>
      <td>${badge}</td>
      <td><div style="display:flex;gap:6px;flex-wrap:wrap">
        ${saldo>0?`<button class="btn-primary btn-abonar-deudor" data-id="${d.id}" style="padding:6px 10px"><i class="ti ti-cash"></i></button>`:''}
        <button class="btn-secundario btn-boucher-deudor" data-id="${d.id}" style="padding:6px 10px"><i class="ti ti-printer"></i></button>
        <button class="btn-secundario btn-editar-deudor" data-id="${d.id}" style="padding:6px 10px"><i class="ti ti-edit"></i></button>
        <button class="btn-peligro btn-eliminar-deudor" data-id="${d.id}" style="padding:6px 10px"><i class="ti ti-trash"></i></button>
      </div></td>
    </tr>`;
  }).join('');

  cont.innerHTML = `<div class="tabla-wrap"><table>
    <thead><tr><th>Deudor</th><th>Producto</th><th>Monto</th><th>Abonado</th><th>Saldo</th><th>Fecha límite</th><th>Estado</th><th>Acciones</th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;

  cont.querySelectorAll('.btn-abonar-deudor').forEach(b => b.addEventListener('click', () => abrirModalAbono(b.dataset.id, 'deudor')));
  cont.querySelectorAll('.btn-boucher-deudor').forEach(b => b.addEventListener('click', () => {
    const d = DB.deudores.find(x=>x.id===b.dataset.id); if (d) imprimirBoucherDeuda(d, 'deudor');
  }));
  cont.querySelectorAll('.btn-editar-deudor').forEach(b => b.addEventListener('click', () => abrirModalDeudor(b.dataset.id)));
  cont.querySelectorAll('.btn-eliminar-deudor').forEach(b => b.addEventListener('click', () => eliminarDeudor(b.dataset.id)));
}

// =============================================
// ANTICIPOS (el producto se queda en el inventario hasta pagar todo)
// =============================================
function agregarProductoAnticipo(p) {
  const existente = productosAnticipo.find(x=>x.productoId===p.id);
  if (existente) {
    if (existente.cantidad >= p.stock) { alert(`Solo hay ${p.stock} unidades disponibles de ${p.nombre}.`); return; }
    existente.cantidad += 1;
  } else {
    if (p.stock < 1) { alert('Sin stock disponible de este producto.'); return; }
    productosAnticipo.push({ productoId: p.id, ref: p.ref, nombre: p.nombre, cantidad: 1, precioUnit: p.pventa1 });
  }
  renderProductosAnticipo();
  recalcularMontoAnticipo();
}

function recalcularMontoAnticipo() {
  const total = productosAnticipo.reduce((a,p)=>a+p.precioUnit*p.cantidad,0);
  if (total>0) document.getElementById('anticipo-monto').value = total;
}

function renderProductosAnticipo() {
  const cont = document.getElementById('anticipo-productos-lista');
  if (productosAnticipo.length === 0) { cont.innerHTML = ''; return; }
  cont.innerHTML = productosAnticipo.map((item,idx) => `
    <div class="carrito-item">
      <div class="item-nombre">
        <strong>${esc(item.nombre)}</strong>
        <span>Ref: ${esc(item.ref)}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <input type="number" value="${item.cantidad}" min="1" class="input-cantidad-anticipo" data-idx="${idx}">
        <span class="item-total">${fmt(item.precioUnit*item.cantidad)}</span>
        <button type="button" class="btn-peligro btn-quitar-producto-anticipo-item" data-idx="${idx}" style="padding:6px 10px"><i class="ti ti-x"></i></button>
      </div>
    </div>`).join('');

  cont.querySelectorAll('.input-cantidad-anticipo').forEach(input => {
    input.addEventListener('change', () => {
      const idx = parseInt(input.dataset.idx);
      const item = productosAnticipo[idx];
      const p = DB.productos.find(x=>x.id===item.productoId);
      let nuevaCant = Math.max(1, parseInt(input.value)||1);
      if (p && nuevaCant > p.stock) {
        alert(`Solo hay ${p.stock} unidades disponibles de ${item.nombre}.`);
        nuevaCant = p.stock > 0 ? p.stock : 1;
      }
      item.cantidad = nuevaCant;
      renderProductosAnticipo();
      recalcularMontoAnticipo();
    });
  });
  cont.querySelectorAll('.btn-quitar-producto-anticipo-item').forEach(b =>
    b.addEventListener('click', () => {
      productosAnticipo.splice(parseInt(b.dataset.idx),1);
      renderProductosAnticipo();
      recalcularMontoAnticipo();
    }));
}

async function guardarAnticipoEnSheet(a, esNuevo) {
  const fila = [a.id,a.clienteId,a.nombre,a.cedula,a.telefono,a.direccion,JSON.stringify(a.productos||[]),a.monto,a.nota,a.fecha,a.hora,a.fechaLimite,JSON.stringify(a.abonos),a.pagada,a.descontado];
  if (esNuevo) return await sheetsEscribir('append','Anticipos',fila);
  return await sheetsEscribir('update','Anticipos',fila,a.id);
}

function abrirModalAnticipo(id) {
  editandoAnticipoId = id || null;
  productosAnticipo = [];
  document.getElementById('anticipo-producto-buscar').value = '';
  document.getElementById('anticipo-producto-resultados').innerHTML = '';
  document.getElementById('anticipo-inicial').value = '';
  document.querySelector('input[name="anticipo-metodo"][value="efectivo"]').checked = true;
  quitarClienteAnticipo();
  document.getElementById('anticipo-cliente-buscar').value = '';
  document.getElementById('anticipo-cliente-resultados').innerHTML = '';
  document.getElementById('modal-anticipo-titulo').textContent = id ? 'Editar anticipo' : 'Agregar anticipo';
  if (id) {
    const a = DB.anticipos.find(x => x.id === id);
    if (!a) return;
    seleccionarClienteAnticipo({ id: a.clienteId, nombre: a.nombre, cedula: a.cedula, telefono: a.telefono });
    productosAnticipo = (a.productos||[]).map(p=>({productoId:p.productoId, ref:p.ref||'', nombre:p.productoNombre, cantidad:p.cantidad, precioUnit:p.precioUnit}));
    document.getElementById('anticipo-monto').value = a.monto;
    document.getElementById('anticipo-nota').value = a.nota||'';
    document.getElementById('anticipo-fecha-limite').value = coAIso(a.fechaLimite);
  } else {
    ['anticipo-monto','anticipo-nota','anticipo-fecha-limite'].forEach(x => document.getElementById(x).value='');
  }
  renderProductosAnticipo();
  abrirModal('modal-anticipo');
}

async function guardarAnticipo() {
  const monto = parseFloat(document.getElementById('anticipo-monto').value)||0;
  const nota = document.getElementById('anticipo-nota').value.trim();
  const fechaLimiteISO = document.getElementById('anticipo-fecha-limite').value;
  if (!clienteAnticipo||!monto) { alert('Selecciona un cliente e ingresa el monto total'); return; }
  for (const item of productosAnticipo) {
    const p = DB.productos.find(x => x.id===item.productoId);
    if (p && item.cantidad > p.stock) { alert(`Solo hay ${p.stock} unidades disponibles de ${item.nombre}.`); return; }
  }

  const fechaLimite = fechaLimiteISO ? isoAFechaCO(fechaLimiteISO) : '';
  const btn = document.getElementById('btn-guardar-anticipo');
  btn.textContent='Guardando...'; btn.disabled=true;
  const productos = productosAnticipo.map(p=>({productoId:p.productoId, ref:p.ref, productoNombre:p.nombre, cantidad:p.cantidad, precioUnit:p.precioUnit}));

  if (editandoAnticipoId) {
    const a = DB.anticipos.find(x => x.id===editandoAnticipoId);
    if (a) {
      Object.assign(a, {
        clienteId: clienteAnticipo.id, nombre: clienteAnticipo.nombre, cedula: clienteAnticipo.cedula,
        telefono: clienteAnticipo.telefono||'', nota, productos, monto, fechaLimite
      });
      await guardarAnticipoEnSheet(a, false);
    }
    btn.textContent='Guardar'; btn.disabled=false;
    guardarLocal(); cerrarModal('modal-anticipo'); renderAnticipos();
    mostrarToast('Anticipo actualizado ✓');
    return;
  }

  const inicial = parseFloat(document.getElementById('anticipo-inicial').value)||0;
  const metodoPago = document.querySelector('input[name="anticipo-metodo"]:checked').value;
  if (inicial > monto) { alert('El pago inicial no puede ser mayor al monto total'); return; }

  const ahora = new Date();
  const nuevo = {
    id: uid(), clienteId: clienteAnticipo.id, nombre: clienteAnticipo.nombre, cedula: clienteAnticipo.cedula,
    telefono: clienteAnticipo.telefono||'', direccion: clienteAnticipo.direccion||'',
    productos,
    monto, nota, fecha: fechaCO(ahora), hora: horaCO(ahora), fechaLimite,
    abonos: [], pagada: false, descontado: false
  };
  DB.anticipos.push(nuevo);
  await guardarAnticipoEnSheet(nuevo, true);

  if (inicial > 0) await registrarPagoDeuda(nuevo, 'anticipo', inicial, metodoPago);

  guardarLocal(); btn.textContent='Guardar'; btn.disabled=false;
  cerrarModal('modal-anticipo'); renderAnticipos(); renderDashboard();
  mostrarToast('Anticipo agregado ✓ (usa el botón de imprimir para el boucher)');
}

async function eliminarAnticipo(id) {
  if (!confirm('¿Eliminar este anticipo?')) return;
  await sheetsEscribir('delete','Anticipos',null,id);
  DB.anticipos = DB.anticipos.filter(a => a.id!==id);
  guardarLocal(); renderAnticipos(); mostrarToast('Anticipo eliminado');
}

function renderAnticipos() {
  const cont = document.getElementById('anticipos-contenido');
  if (DB.anticipos.length === 0) {
    cont.innerHTML = `<div class="estado-vacio"><i class="ti ti-cash-banknote"></i><p>Sin anticipos registrados.</p></div>`;
    return;
  }

  const ordenados = DB.anticipos.slice().sort((a,b) => (calcularSaldo(b)>0?1:0) - (calcularSaldo(a)>0?1:0));

  const filas = ordenados.map(a => {
    const saldo = calcularSaldo(a);
    const abonado = calcularAbonado(a);
    const vencida = deudaVencida(a);
    const badge = saldo<=0 ? '<span class="badge ok">Completado</span>'
      : vencida ? '<span class="badge danger">Vencido</span>'
      : '<span class="badge alerta">Pendiente</span>';
    return `<tr>
      <td>${esc(a.nombre)}<div style="font-size:11px;color:var(--texto2)">CC ${esc(a.cedula)}</div></td>
      <td style="font-size:13px">${a.productos&&a.productos.length?a.productos.map(p=>esc(p.productoNombre)+' x'+p.cantidad).join(', '):'-'}</td>
      <td>${fmt(a.monto)}</td>
      <td>${fmt(abonado)}</td>
      <td style="font-weight:500">${fmt(saldo)}</td>
      <td style="font-size:13px">${a.fechaLimite||'-'}</td>
      <td>${badge}</td>
      <td><div style="display:flex;gap:6px;flex-wrap:wrap">
        ${saldo>0?`<button class="btn-primary btn-abonar-anticipo" data-id="${a.id}" style="padding:6px 10px"><i class="ti ti-cash"></i></button>`:''}
        <button class="btn-secundario btn-boucher-anticipo" data-id="${a.id}" style="padding:6px 10px"><i class="ti ti-printer"></i></button>
        <button class="btn-secundario btn-editar-anticipo" data-id="${a.id}" style="padding:6px 10px"><i class="ti ti-edit"></i></button>
        <button class="btn-peligro btn-eliminar-anticipo" data-id="${a.id}" style="padding:6px 10px"><i class="ti ti-trash"></i></button>
      </div></td>
    </tr>`;
  }).join('');

  cont.innerHTML = `<div class="tabla-wrap"><table>
    <thead><tr><th>Cliente</th><th>Producto</th><th>Monto</th><th>Abonado</th><th>Saldo</th><th>Fecha límite</th><th>Estado</th><th>Acciones</th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;

  cont.querySelectorAll('.btn-abonar-anticipo').forEach(b => b.addEventListener('click', () => abrirModalAbono(b.dataset.id, 'anticipo')));
  cont.querySelectorAll('.btn-boucher-anticipo').forEach(b => b.addEventListener('click', () => {
    const a = DB.anticipos.find(x=>x.id===b.dataset.id); if (a) imprimirBoucherDeuda(a, 'anticipo');
  }));
  cont.querySelectorAll('.btn-editar-anticipo').forEach(b => b.addEventListener('click', () => abrirModalAnticipo(b.dataset.id)));
  cont.querySelectorAll('.btn-eliminar-anticipo').forEach(b => b.addEventListener('click', () => eliminarAnticipo(b.dataset.id)));
}

// =============================================
// PROVEEDORES
// =============================================
function proveedorPorVencer(p) {
  if (!p.fechaLimite || calcularSaldo(p) <= 0) return false;
  const hoy = new Date(); hoy.setHours(0,0,0,0);
  const dias = Math.round((parseFechaCO(p.fechaLimite) - hoy) / 86400000);
  return dias >= 0 && dias <= 3;
}

async function guardarProveedorEnSheet(p, esNuevo) {
  const fila = [p.id,p.empresa,p.fechaLlegadaPedido,p.monto,p.numeroCuotas,p.fechaLimite,p.fecha,p.hora,JSON.stringify(p.abonos),p.pagada];
  if (esNuevo) return await sheetsEscribir('append','Proveedores',fila);
  return await sheetsEscribir('update','Proveedores',fila,p.id);
}

function abrirModalProveedor() {
  ['proveedor-empresa','proveedor-fecha-llegada','proveedor-monto','proveedor-fecha-limite'].forEach(x => document.getElementById(x).value='');
  document.getElementById('proveedor-cuotas').value = '1';
  abrirModal('modal-proveedor');
}

async function guardarProveedor() {
  const empresa = document.getElementById('proveedor-empresa').value.trim();
  const fechaLlegadaISO = document.getElementById('proveedor-fecha-llegada').value;
  const monto = parseFloat(document.getElementById('proveedor-monto').value)||0;
  const numeroCuotas = parseInt(document.getElementById('proveedor-cuotas').value)||1;
  const fechaLimiteISO = document.getElementById('proveedor-fecha-limite').value;
  if (!empresa||!monto) { alert('Completa los campos obligatorios (*)'); return; }

  const ahora = new Date();
  const nuevo = {
    id: uid(), empresa,
    fechaLlegadaPedido: fechaLlegadaISO ? isoAFechaCO(fechaLlegadaISO) : '',
    monto, numeroCuotas,
    fechaLimite: fechaLimiteISO ? isoAFechaCO(fechaLimiteISO) : '',
    fecha: fechaCO(ahora), hora: horaCO(ahora),
    abonos: [], pagada: false
  };
  DB.proveedores.push(nuevo);
  await guardarProveedorEnSheet(nuevo, true);

  guardarLocal();
  cerrarModal('modal-proveedor');
  renderProveedores();
  renderDashboard();
  mostrarToast('Factura de proveedor agregada ✓');
}

async function eliminarProveedor(id) {
  if (!confirm('¿Eliminar esta factura de proveedor?')) return;
  await sheetsEscribir('delete','Proveedores',null,id);
  DB.proveedores = DB.proveedores.filter(p => p.id!==id);
  guardarLocal(); renderProveedores(); mostrarToast('Factura eliminada');
}

function abrirModalAbonoProveedor(id) {
  proveedorAbonoActual = id;
  const p = DB.proveedores.find(x => x.id===id);
  if (!p) return;
  document.getElementById('abono-proveedor-nombre').textContent = p.empresa;
  document.getElementById('abono-proveedor-saldo').textContent = `Saldo pendiente: ${fmt(calcularSaldo(p))}`;
  document.getElementById('abono-proveedor-monto').value = '';
  document.querySelector('input[name="abono-proveedor-metodo"][value="efectivo"]').checked = true;
  abrirModal('modal-abono-proveedor');
  setTimeout(() => document.getElementById('abono-proveedor-monto').focus(), 100);
}

async function guardarAbonoProveedor() {
  const p = DB.proveedores.find(x => x.id===proveedorAbonoActual);
  if (!p) return;
  const monto = parseFloat(document.getElementById('abono-proveedor-monto').value)||0;
  const saldo = calcularSaldo(p);
  if (!monto || monto<=0) { alert('Ingresa un monto válido'); return; }
  if (monto > saldo) { alert(`El pago no puede ser mayor al saldo pendiente (${fmt(saldo)})`); return; }
  const metodoPago = document.querySelector('input[name="abono-proveedor-metodo"]:checked').value;

  const ahora = new Date();
  p.abonos = p.abonos || [];
  p.abonos.push({ id: uid(), monto, metodoPago, fecha: fechaCO(ahora), hora: horaCO(ahora) });
  p.pagada = calcularSaldo(p) <= 0;

  await guardarProveedorEnSheet(p, false);
  guardarLocal();
  cerrarModal('modal-abono-proveedor');
  renderProveedores();
  renderDashboard();
  mostrarToast(p.pagada ? 'Factura pagada completamente ✓' : `Pago registrado · ${fmt(monto)}. Usa el botón de imprimir si quieres el boucher.`);
}

function imprimirBoucherProveedor(p) {
  const ahora = new Date();
  const abonos = p.abonos||[];
  const saldo = calcularSaldo(p);
  const valorCuota = p.numeroCuotas>0 ? p.monto/p.numeroCuotas : p.monto;
  const cuotasPendientes = valorCuota>0 ? Math.min(p.numeroCuotas, Math.ceil(saldo/valorCuota)) : 0;

  const filasAbonos = abonos.map((a,i) => `
    <tr>
      <td>${i+1}</td>
      <td>${a.fecha} ${a.hora}</td>
      <td>${a.metodoPago==='transferencia'?'Transferencia':'Efectivo'}</td>
      <td style="text-align:right">${fmt(a.monto)}</td>
    </tr>`).join('');

  document.getElementById('proveedor-print-contenido').innerHTML = `
    <div id="tp-header">
      <h1>Crem Helado</h1>
      <p>Comprobante de pago a proveedor</p>
    </div>
    <div id="tp-meta">
      <span><strong>Fecha:</strong> ${fechaCO(ahora)}</span>
      <span><strong>Hora:</strong> ${horaCO(ahora)}</span>
    </div>
    <p style="font-size:13px;margin-bottom:4px"><strong>Proveedor:</strong> ${esc(p.empresa)}</p>
    ${p.fechaLlegadaPedido?`<p style="font-size:13px;margin-bottom:4px"><strong>Fecha de llegada del pedido:</strong> ${p.fechaLlegadaPedido}</p>`:''}
    <p style="font-size:13px;margin-bottom:4px"><strong>Cuotas pendientes:</strong> ${cuotasPendientes} de ${p.numeroCuotas}</p>
    ${p.fechaLimite?`<p style="font-size:13px;margin-bottom:12px"><strong>Fecha límite de pago:</strong> ${p.fechaLimite}</p>`:''}
    <p style="margin-top:8px;font-size:14px"><strong>Monto total del pedido: ${fmt(p.monto)}</strong></p>
    ${abonos.length?`
      <p style="margin-top:12px;font-size:13px"><strong>Pagos realizados:</strong></p>
      <table>
        <thead><tr><th>#</th><th>Fecha</th><th>Método</th><th>Monto</th></tr></thead>
        <tbody>${filasAbonos}</tbody>
      </table>`:''}
    <p style="margin-top:12px;font-size:16px"><strong>Saldo pendiente: ${fmt(saldo)}</strong></p>
    ${saldo<=0?'<p style="text-align:center;margin-top:8px;font-size:13px">FACTURA CANCELADA EN SU TOTALIDAD</p>':''}
  `;

  prepararImpresion('proveedor-print');
  window.print();
}

function renderProveedores() {
  const cont = document.getElementById('proveedores-contenido');
  if (DB.proveedores.length === 0) {
    cont.innerHTML = `<div class="estado-vacio"><i class="ti ti-building-warehouse"></i><p>Sin facturas de proveedores registradas.</p></div>`;
    return;
  }

  const ordenados = DB.proveedores.slice().sort((a,b) => (calcularSaldo(b)>0?1:0) - (calcularSaldo(a)>0?1:0));

  const filas = ordenados.map(p => {
    const saldo = calcularSaldo(p);
    const abonado = calcularAbonado(p);
    const vencida = deudaVencida(p);
    const porVencer = proveedorPorVencer(p);
    const badge = saldo<=0 ? '<span class="badge ok">Pagada</span>'
      : vencida ? '<span class="badge danger">Vencida</span>'
      : porVencer ? '<span class="badge alerta">Por vencer</span>'
      : '<span class="badge rosa">Pendiente</span>';
    return `<tr>
      <td>${esc(p.empresa)}</td>
      <td style="font-size:13px">${p.fechaLlegadaPedido||'-'}</td>
      <td>${fmt(p.monto)}</td>
      <td>${fmt(abonado)}</td>
      <td style="font-weight:500">${fmt(saldo)}</td>
      <td style="font-size:13px">${p.numeroCuotas}</td>
      <td style="font-size:13px">${p.fechaLimite||'-'}</td>
      <td>${badge}</td>
      <td><div style="display:flex;gap:6px;flex-wrap:wrap">
        ${saldo>0?`<button class="btn-primary btn-abonar-proveedor" data-id="${p.id}" style="padding:6px 10px"><i class="ti ti-cash"></i></button>`:''}
        <button class="btn-secundario btn-boucher-proveedor" data-id="${p.id}" style="padding:6px 10px"><i class="ti ti-printer"></i></button>
        <button class="btn-peligro btn-eliminar-proveedor" data-id="${p.id}" style="padding:6px 10px"><i class="ti ti-trash"></i></button>
      </div></td>
    </tr>`;
  }).join('');

  cont.innerHTML = `<div class="tabla-wrap"><table>
    <thead><tr><th>Empresa</th><th>Llegada pedido</th><th>Monto</th><th>Abonado</th><th>Saldo</th><th>Cuotas</th><th>Fecha límite</th><th>Estado</th><th>Acciones</th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;

  cont.querySelectorAll('.btn-abonar-proveedor').forEach(b => b.addEventListener('click', () => abrirModalAbonoProveedor(b.dataset.id)));
  cont.querySelectorAll('.btn-boucher-proveedor').forEach(b => b.addEventListener('click', () => {
    const p = DB.proveedores.find(x=>x.id===b.dataset.id); if (p) imprimirBoucherProveedor(p);
  }));
  cont.querySelectorAll('.btn-eliminar-proveedor').forEach(b => b.addEventListener('click', () => eliminarProveedor(b.dataset.id)));
}

// =============================================
// GASTOS DEL LOCAL
// =============================================
function seleccionarCategoriaGasto(cat, btn) {
  gastoCategoriaSeleccionada = cat;
  document.querySelectorAll('.gasto-cat-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
}

function abrirModalGasto() {
  gastoCategoriaSeleccionada = null;
  document.querySelectorAll('.gasto-cat-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('gasto-monto').value = '';
  document.getElementById('gasto-nota').value = '';
  document.querySelector('input[name="gasto-metodo"][value="efectivo"]').checked = true;
  document.getElementById('gasto-mixto-efectivo').value = 0;
  document.getElementById('gasto-mixto-transferencia').value = 0;
  document.getElementById('gasto-mixto-box').classList.add('hidden');
  abrirModal('modal-gasto');
}

async function guardarGasto() {
  const monto = parseFloat(document.getElementById('gasto-monto').value)||0;
  const metodoPago = document.querySelector('input[name="gasto-metodo"]:checked').value;
  const nota = document.getElementById('gasto-nota').value.trim();
  if (!gastoCategoriaSeleccionada) { alert('Selecciona una categoría de gasto'); return; }
  if (!monto || monto<=0) { alert('Ingresa un monto válido'); return; }

  let efectivo, transferencia;
  if (metodoPago === 'mixto') {
    efectivo = parseFloat(document.getElementById('gasto-mixto-efectivo').value)||0;
    transferencia = parseFloat(document.getElementById('gasto-mixto-transferencia').value)||0;
    if (efectivo < 0 || transferencia < 0 || Math.round(efectivo+transferencia) !== Math.round(monto)) {
      alert('El pago combinado no cuadra: efectivo + transferencia debe ser igual al monto del gasto.');
      return;
    }
  }

  const ahora = new Date();
  const gasto = { id: uid(), categoria: gastoCategoriaSeleccionada, monto, metodoPago, fecha: fechaCO(ahora), hora: horaCO(ahora), nota, efectivo, transferencia };
  DB.gastos.push(gasto);
  await sheetsEscribir('append','Gastos',[gasto.id,gasto.categoria,gasto.monto,gasto.metodoPago,gasto.fecha,gasto.hora,gasto.nota,efectivo!=null?efectivo:'',transferencia!=null?transferencia:'']);

  guardarLocal();
  cerrarModal('modal-gasto');
  renderGastos();
  renderDashboard();
  mostrarToast('Gasto registrado ✓');
}

// ---- Reparto efectivo / transferencia (incluye pago combinado) ----
function partesVenta(v) {
  const total = v.total || 0, gan = v.ganancia || 0;
  let tr = 0;
  if (v.metodoPago === 'transferencia') tr = total;
  else if (v.metodoPago === 'mixto' && v.pagoTr != null) tr = Math.min(total, Math.max(0, v.pagoTr));
  const f = total ? tr / total : 0;
  return { ef: total - tr, tr, gEf: gan - gan * f, gTr: gan * f };
}
function partesGasto(g) {
  const monto = g.monto || 0;
  let tr = 0;
  if (g.metodoPago === 'transferencia') tr = monto;
  else if (g.metodoPago === 'mixto' && g.transferencia != null) tr = Math.min(monto, Math.max(0, g.transferencia));
  return { ef: monto - tr, tr };
}
function resumenMetodos(ventas, gastos, costos) {
  costos = costos || [];
  const r = { vendido:0, ganancia:0, vEf:0, vTr:0, gaEf:0, gaTr:0, gasto:0, gsEf:0, gsTr:0, costo:0, csEf:0, csTr:0 };
  ventas.forEach(v => { const p = partesVenta(v); r.vendido += v.total; r.ganancia += v.ganancia; r.vEf += p.ef; r.vTr += p.tr; r.gaEf += p.gEf; r.gaTr += p.gTr; });
  gastos.forEach(g => { const p = partesGasto(g); r.gasto += g.monto; r.gsEf += p.ef; r.gsTr += p.tr; });
  costos.forEach(c => { const p = partesGasto(c); r.costo += c.monto; r.csEf += p.ef; r.csTr += p.tr; });
  r.netoEf = r.gaEf - r.gsEf - r.csEf; r.netoTr = r.gaTr - r.gsTr - r.csTr; r.neto = r.ganancia - r.gasto - r.costo;
  return r;
}
function badgeMetodo(x) {
  if (x.metodoPago === 'mixto') {
    const detalle = (x.metodoPago === 'mixto' && (x.efectivo != null || x.pagoEf != null))
      ? `title="Efectivo ${fmt(x.efectivo != null ? x.efectivo : x.pagoEf)} · Transferencia ${fmt(x.transferencia != null ? x.transferencia : x.pagoTr)}"` : '';
    return `<span class="badge ok" ${detalle}>🔀 Combinado</span>`;
  }
  return `<span class="badge ${x.metodoPago==='transferencia'?'rosa':'verde'}">${x.metodoPago==='transferencia'?'🏦 Transferencia':'💵 Efectivo'}</span>`;
}

function gastoActualizarMixto() {
  const mixto = document.querySelector('input[name="gasto-metodo"]:checked').value === 'mixto';
  document.getElementById('gasto-mixto-box').classList.toggle('hidden', !mixto);
  if (mixto) gastoMixtoDesde('monto');
}
function gastoMixtoDesde(origen) {
  const monto = parseFloat(document.getElementById('gasto-monto').value)||0;
  const ef = document.getElementById('gasto-mixto-efectivo');
  const tr = document.getElementById('gasto-mixto-transferencia');
  if (origen === 'tr') ef.value = Math.max(0, monto - (parseFloat(tr.value)||0));
  else tr.value = Math.max(0, monto - (parseFloat(ef.value)||0));
  const resto = monto - (parseFloat(ef.value)||0) - (parseFloat(tr.value)||0);
  const info = document.getElementById('gasto-mixto-info');
  info.textContent = Math.round(resto) === 0 ? 'Cuadra con el monto ✓' : `Falta repartir ${fmt(resto)}`;
  info.style.color = Math.round(resto) === 0 ? 'var(--malva)' : '#A32D2D';
}

async function eliminarGasto(id) {
  if (!confirm('¿Eliminar este gasto?')) return;
  await sheetsEscribir('delete','Gastos',null,id);
  DB.gastos = DB.gastos.filter(g => g.id!==id);
  guardarLocal(); renderGastos(); renderDashboard(); mostrarToast('Gasto eliminado');
}

function renderGastos() {
  const ahora = new Date();
  const gastosMes = DB.gastos.filter(g => {
    const d = parseFechaCO(g.fecha);
    return d.getMonth()===ahora.getMonth() && d.getFullYear()===ahora.getFullYear();
  });
  const totalMes = gastosMes.reduce((a,g)=>a+g.monto,0);
  const efectivoMes = gastosMes.reduce((a,g)=>a+partesGasto(g).ef,0);
  const transferenciaMes = gastosMes.reduce((a,g)=>a+partesGasto(g).tr,0);

  document.getElementById('gastos-resumen').innerHTML = `
    <div id="dash-metrics">
      <div class="metric rosa"><div class="mlabel">Gastos de este mes</div><div class="mvalue">${fmt(totalMes)}</div></div>
      <div class="metric"><div class="mlabel">💵 Efectivo</div><div class="mvalue">${fmt(efectivoMes)}</div></div>
      <div class="metric"><div class="mlabel">🏦 Transferencia</div><div class="mvalue">${fmt(transferenciaMes)}</div></div>
    </div>`;

  const cont = document.getElementById('gastos-contenido');
  if (DB.gastos.length === 0) {
    cont.innerHTML = `<div class="estado-vacio"><i class="ti ti-receipt-2"></i><p>Sin gastos registrados.</p></div>`;
    return;
  }

  const filas = DB.gastos.slice().reverse().map(g => `
    <tr>
      <td>${g.fecha}</td>
      <td><span class="badge rosa">${esc(g.categoria)}</span></td>
      <td>${fmt(g.monto)}</td>
      <td>${badgeMetodo(g)}</td>
      <td style="font-size:13px;color:var(--texto2)">${esc(g.nota)||'-'}</td>
      <td><button class="btn-peligro btn-eliminar-gasto" data-id="${g.id}" style="padding:5px 9px"><i class="ti ti-trash"></i></button></td>
    </tr>`).join('');

  cont.innerHTML = `<div class="tabla-wrap"><table>
    <thead><tr><th>Fecha</th><th>Categoría</th><th>Monto</th><th>Método</th><th>Nota</th><th></th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;

  cont.querySelectorAll('.btn-eliminar-gasto').forEach(b => b.addEventListener('click', () => eliminarGasto(b.dataset.id)));
}

// =============================================
// COSTOS (insumos: vasos, bolsas, cucharas…)
// =============================================
let costoCategoriaSeleccionada = null;

function seleccionarCategoriaCosto(cat, btn) {
  costoCategoriaSeleccionada = cat;
  document.querySelectorAll('.costo-cat-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
}

function abrirModalCosto() {
  costoCategoriaSeleccionada = null;
  document.querySelectorAll('.costo-cat-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('costo-monto').value = '';
  document.getElementById('costo-nota').value = '';
  document.querySelector('input[name="costo-metodo"][value="efectivo"]').checked = true;
  document.getElementById('costo-mixto-efectivo').value = 0;
  document.getElementById('costo-mixto-transferencia').value = 0;
  document.getElementById('costo-mixto-box').classList.add('hidden');
  abrirModal('modal-costo');
}

function costoActualizarMixto() {
  const mixto = document.querySelector('input[name="costo-metodo"]:checked').value === 'mixto';
  document.getElementById('costo-mixto-box').classList.toggle('hidden', !mixto);
  if (mixto) costoMixtoDesde('monto');
}
function costoMixtoDesde(origen) {
  const monto = parseFloat(document.getElementById('costo-monto').value)||0;
  const ef = document.getElementById('costo-mixto-efectivo');
  const tr = document.getElementById('costo-mixto-transferencia');
  if (origen === 'tr') ef.value = Math.max(0, monto - (parseFloat(tr.value)||0));
  else tr.value = Math.max(0, monto - (parseFloat(ef.value)||0));
  const resto = monto - (parseFloat(ef.value)||0) - (parseFloat(tr.value)||0);
  const info = document.getElementById('costo-mixto-info');
  info.textContent = Math.round(resto) === 0 ? 'Cuadra con el monto ✓' : `Falta repartir ${fmt(resto)}`;
  info.style.color = Math.round(resto) === 0 ? 'var(--malva)' : '#A32D2D';
}

async function guardarCosto() {
  const monto = parseFloat(document.getElementById('costo-monto').value)||0;
  const metodoPago = document.querySelector('input[name="costo-metodo"]:checked').value;
  const nota = document.getElementById('costo-nota').value.trim();
  if (!costoCategoriaSeleccionada) { alert('Selecciona una categoría de costo'); return; }
  if (!monto || monto<=0) { alert('Ingresa un monto válido'); return; }

  let efectivo, transferencia;
  if (metodoPago === 'mixto') {
    efectivo = parseFloat(document.getElementById('costo-mixto-efectivo').value)||0;
    transferencia = parseFloat(document.getElementById('costo-mixto-transferencia').value)||0;
    if (efectivo < 0 || transferencia < 0 || Math.round(efectivo+transferencia) !== Math.round(monto)) {
      alert('El pago combinado no cuadra: efectivo + transferencia debe ser igual al monto del costo.');
      return;
    }
  }

  const ahora = new Date();
  const costo = { id: uid(), categoria: costoCategoriaSeleccionada, monto, metodoPago, fecha: fechaCO(ahora), hora: horaCO(ahora), nota, efectivo, transferencia };
  const ok = await sheetsEscribir('append','Costos',[costo.id,costo.categoria,costo.monto,costo.metodoPago,costo.fecha,costo.hora,costo.nota,efectivo!=null?efectivo:'',transferencia!=null?transferencia:'']);
  DB.costos.push(costo);

  guardarLocal();
  cerrarModal('modal-costo');
  renderCostos();
  renderDashboard();
  mostrarToast('Costo registrado ✓');
}

async function eliminarCosto(id) {
  if (!confirm('¿Eliminar este costo?')) return;
  await sheetsEscribir('delete','Costos',null,id);
  DB.costos = DB.costos.filter(c => c.id!==id);
  guardarLocal(); renderCostos(); renderDashboard(); mostrarToast('Costo eliminado');
}

function renderCostos() {
  const ahora = new Date();
  const costosMes = DB.costos.filter(c => {
    const d = parseFechaCO(c.fecha);
    return d.getMonth()===ahora.getMonth() && d.getFullYear()===ahora.getFullYear();
  });
  const totalMes = costosMes.reduce((a,c)=>a+c.monto,0);
  const efectivoMes = costosMes.reduce((a,c)=>a+partesGasto(c).ef,0);
  const transferenciaMes = costosMes.reduce((a,c)=>a+partesGasto(c).tr,0);

  document.getElementById('costos-resumen').innerHTML = `
    <div id="dash-metrics">
      <div class="metric rosa"><div class="mlabel">Costos de este mes</div><div class="mvalue">${fmt(totalMes)}</div></div>
      <div class="metric"><div class="mlabel">💵 Efectivo</div><div class="mvalue">${fmt(efectivoMes)}</div></div>
      <div class="metric"><div class="mlabel">🏦 Transferencia</div><div class="mvalue">${fmt(transferenciaMes)}</div></div>
    </div>`;

  const porCat = {};
  costosMes.forEach(c => { porCat[c.categoria] = (porCat[c.categoria] || 0) + c.monto; });
  const cats = Object.keys(porCat).sort((a,b) => porCat[b]-porCat[a]);
  document.getElementById('costos-categorias-mes').innerHTML = cats.length
    ? `<p class="rep-seccion" style="margin-top:0">Por categoría este mes</p>
       <div class="rep-neto-grid" style="margin-bottom:1.25rem">${cats.map(k=>`<div class="reporte-pago-card"><div class="rp-label">${esc(k)}</div><div class="rp-value">${fmt(porCat[k])}</div></div>`).join('')}</div>`
    : '';

  const cont = document.getElementById('costos-contenido');
  if (DB.costos.length === 0) {
    cont.innerHTML = `<div class="estado-vacio"><i class="ti ti-box-seam"></i><p>Sin costos registrados.</p></div>`;
    return;
  }

  const filas = DB.costos.slice().reverse().map(c => `
    <tr>
      <td>${c.fecha}</td>
      <td><span class="badge rosa">${esc(c.categoria)}</span></td>
      <td>${fmt(c.monto)}</td>
      <td>${badgeMetodo(c)}</td>
      <td style="font-size:13px;color:var(--texto2)">${esc(c.nota)||'-'}</td>
      <td><button class="btn-peligro btn-eliminar-costo" data-id="${c.id}" style="padding:5px 9px"><i class="ti ti-trash"></i></button></td>
    </tr>`).join('');

  cont.innerHTML = `<div class="tabla-wrap"><table>
    <thead><tr><th>Fecha</th><th>Categoría</th><th>Monto</th><th>Método</th><th>Detalle</th><th></th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;

  cont.querySelectorAll('.btn-eliminar-costo').forEach(b => b.addEventListener('click', () => eliminarCosto(b.dataset.id)));
}

// =============================================
// DASHBOARD
// =============================================
function mostrarModalStock(tipo) {
  const lista = tipo === 'sin'
    ? DB.productos.filter(p => p.stock <= 0)
    : DB.productos.filter(p => p.stock > 0 && p.stock <= DB.config.stockMin);

  document.getElementById('modal-stock-titulo').textContent =
    tipo === 'sin' ? `Productos sin stock (${lista.length})` : `Productos con stock bajo (${lista.length})`;

  const cont = document.getElementById('modal-stock-contenido');

  if (lista.length === 0) {
    cont.innerHTML = `<div class="estado-vacio"><i class="ti ti-package"></i><p>No hay productos en esta categoría.</p></div>`;
  } else {
    const ordenados = lista.slice().sort((a,b) => a.stock - b.stock);
    const filas = ordenados.map(p => `
      <tr>
        <td><code style="background:var(--blush-claro);padding:2px 7px;border-radius:4px;font-size:12px">${esc(p.ref)}</code></td>
        <td>${esc(p.nombre)}</td>
        <td style="text-align:center;font-weight:600;${p.stock<0?'color:#A32D2D':''}">${p.stock}</td>
      </tr>`).join('');
    cont.innerHTML = `<div class="tabla-wrap"><table>
      <thead><tr><th>Ref</th><th>Nombre</th><th>Stock</th></tr></thead>
      <tbody>${filas}</tbody></table></div>`;
  }

  abrirModal('modal-stock');
}

function renderDashboard() {
  const hoy = fechaCO();
  const ventasHoy = DB.ventas.filter(v => v.fecha === hoy);
  const totalVendidoBruto = ventasHoy.reduce((a,v) => a+v.total, 0);
  const gastosHoy = DB.gastos.filter(g => g.fecha === hoy).reduce((a,g) => a+g.monto, 0);
  const costosHoy = DB.costos.filter(c => c.fecha === hoy).reduce((a,c) => a+c.monto, 0);
  const totalVendido = totalVendidoBruto - gastosHoy - costosHoy;
  const sinStock  = DB.productos.filter(p => p.stock <= 0).length;
  const stockBajo = DB.productos.filter(p => p.stock > 0 && p.stock <= DB.config.stockMin).length;
  const deudasVencidas = DB.deudores.filter(d => deudaVencida(d)).length;
  const anticiposVencidos = DB.anticipos.filter(a => deudaVencida(a)).length;
  const facturasPorVencer = DB.proveedores.filter(p => proveedorPorVencer(p)).length;
  const facturasVencidas = DB.proveedores.filter(p => deudaVencida(p)).length;

  document.getElementById('dash-fecha').textContent = 'Hoy · ' + new Date().toLocaleDateString('es-CO',{weekday:'long',year:'numeric',month:'long',day:'numeric'});

  document.getElementById('dash-metrics').innerHTML = `
    <div class="metric rosa"><div class="mlabel">Total vendido hoy (neto)</div><div class="mvalue">${fmt(totalVendido)}</div></div>
    ${gastosHoy>0?`<div class="metric danger"><div class="mlabel">Gastos de hoy</div><div class="mvalue">${fmt(gastosHoy)}</div></div>`:''}
    ${costosHoy>0?`<div class="metric danger"><div class="mlabel">Costos de hoy</div><div class="mvalue">${fmt(costosHoy)}</div></div>`:''}
    <div class="metric"><div class="mlabel">Transacciones</div><div class="mvalue">${ventasHoy.length}</div></div>
    <div class="metric"><div class="mlabel">Productos</div><div class="mvalue">${DB.productos.length}</div></div>
    ${stockBajo>0?`<div class="metric alerta metric-clickeable" data-stock="bajo"><div class="mlabel">Stock bajo</div><div class="mvalue">${stockBajo}</div></div>`:''}
    ${sinStock>0?`<div class="metric danger metric-clickeable" data-stock="sin"><div class="mlabel">Sin stock</div><div class="mvalue">${sinStock}</div></div>`:''}
    ${deudasVencidas>0?`<div class="metric danger"><div class="mlabel">Deudas vencidas</div><div class="mvalue">${deudasVencidas}</div></div>`:''}
    ${facturasPorVencer>0?`<div class="metric alerta"><div class="mlabel">Facturas por vencer</div><div class="mvalue">${facturasPorVencer}</div></div>`:''}
    ${facturasVencidas>0?`<div class="metric danger"><div class="mlabel">Facturas vencidas</div><div class="mvalue">${facturasVencidas}</div></div>`:''}
  `;

  document.querySelectorAll('#dash-metrics .metric-clickeable').forEach(el =>
    el.addEventListener('click', () => mostrarModalStock(el.dataset.stock)));

  const cont = document.getElementById('dash-ventas-hoy');
  if (ventasHoy.length === 0) {
    cont.innerHTML = `<div class="estado-vacio"><i class="ti ti-shopping-bag"></i><p>Sin ventas hoy. ¡A vender!</p></div>`;
    return;
  }

  const filas = ventasHoy.slice().reverse().map(v => `
    <tr class="fila-venta-clickeable" data-id="${v.id}">
      <td>${v.hora}</td>
      <td style="font-size:13px">${(v.items||[]).map(i=>esc(i.nombre)+' x'+i.cantidad).join(', ')}</td>
      <td style="font-size:13px;color:var(--texto2)">${v.nota||'-'}</td>
      <td><span class="badge ${v.metodoPago==='transferencia'?'rosa':'verde'}">${v.metodoPago==='transferencia'?'🏦 Transferencia':'💵 Efectivo'}</span></td>
      <td style="font-weight:500">${fmt(v.total)}</td>
      <td><i class="ti ti-receipt" style="color:var(--rosa-medio);font-size:16px"></i></td>
    </tr>`).join('');

  cont.innerHTML = `<div class="tabla-wrap"><table>
    <thead><tr><th>Hora</th><th>Productos</th><th>Nota</th><th>Pago</th><th>Total</th><th></th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;

  cont.querySelectorAll('.fila-venta-clickeable').forEach(f =>
    f.addEventListener('click', () => {
      const v = DB.ventas.find(x => x.id === f.dataset.id);
      if (v) abrirFactura(v);
    }));
}

// =============================================
// IMPRESIÓN TÉRMICA POS (QZ Tray + ESC/POS)
// =============================================
// La venta se imprime directamente en la CX-POS por QZ Tray.
// La firma de QZ se configura EXTERNAMENTE en qz-security.js usando
// Google Apps Script. La clave privada NUNCA debe estar en este archivo
// ni en GitHub.

const POS_IMPRESORA = 'Crem Helado POS'; // <-- cuando tengas impresora térmica para este negocio, pon aquí el nombre EXACTO que le pongas en QZ Tray
const POS_ANCHO = 42;
const POS_CODEPAGE = 'IBM437';

const POS_ESC = '\x1B';
const POS_GS  = '\x1D';
const POS_INIT        = POS_ESC + '@';
const POS_ALINEAR_IZQ = POS_ESC + 'a' + '\x00';
const POS_ALINEAR_CEN = POS_ESC + 'a' + '\x01';
const POS_NEGRITA_ON  = POS_ESC + 'E' + '\x01';
const POS_NEGRITA_OFF = POS_ESC + 'E' + '\x00';
const POS_ALTO_ON     = POS_GS  + '!' + '\x01';
const POS_ALTO_OFF    = POS_GS  + '!' + '\x00';
const POS_CORTE       = '\n\n\n\n\n\n' + POS_GS + 'V' + '\x01';

let qzConectando = null;

// Limpia caracteres que la impresora CP437 no puede representar bien.
function posLimpiarTexto(texto) {
  return String(texto == null ? '' : texto)
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/[^\x00-\x7FÁÉÍÓÚáéíóúÑñ¿¡]/g, '');
}

function posRepetir(caracter, veces) {
  return new Array(Math.max(0, veces) + 1).join(caracter);
}

function posTruncar(texto, ancho) {
  texto = posLimpiarTexto(texto);
  return texto.length > ancho ? texto.slice(0, Math.max(0, ancho - 1)) + '.' : texto;
}

function posColumnas(codigo, producto, cant, precio) {
  const cCod = 12, cProd = 15, cCant = 5;
  const cPrecio = POS_ANCHO - cCod - cProd - cCant;
  const col1 = posTruncar(codigo, cCod - 1).padEnd(cCod);
  const col2 = posTruncar(producto, cProd - 1).padEnd(cProd);
  const col3 = String(cant).padStart(cCant);
  const col4 = String(precio).padStart(cPrecio);
  return col1 + col2 + col3 + col4;
}

function posLinea() {
  return posRepetir('-', POS_ANCHO) + '\n';
}

// Parte un texto largo en varias lineas de máximo 'ancho' caracteres,
// respetando palabras completas cuando se puede. Se usa para el nombre
// del producto en el ticket, para no truncarlo nunca.
function posWrap(texto, ancho) {
  texto = posLimpiarTexto(texto);
  const palabras = texto.split(' ').filter(Boolean);
  const lineas = [];
  let actual = '';
  palabras.forEach(p => {
    const prueba = actual ? actual + ' ' + p : p;
    if (prueba.length > ancho) {
      if (actual) lineas.push(actual);
      actual = p.length > ancho ? p.slice(0, ancho) : p;
    } else {
      actual = prueba;
    }
  });
  if (actual) lineas.push(actual);
  return lineas.length ? lineas : [''];
}

// Construye el ticket físico de una venta.
function construirTicketVentaPOS(venta) {
  const metodoTexto = venta.metodoPago === 'transferencia' ? 'Transferencia' : 'Efectivo';
  let t = '';

  t += POS_INIT;
  t += POS_ALINEAR_CEN;
  t += POS_ALTO_ON + POS_NEGRITA_ON;
  t += posLimpiarTexto('CREM HELADO') + '\n';
  t += POS_ALTO_OFF + POS_NEGRITA_OFF;
  t += posLimpiarTexto('COMPROBANTE DE VENTA') + '\n';

  t += POS_ALINEAR_IZQ;
  t += posLinea();
  t += `Fecha: ${posLimpiarTexto(venta.fecha)}    Hora: ${posLimpiarTexto(venta.hora)}\n`;

  if (venta.clienteNombre) {
    t += posLinea();
    t += `Cliente: ${posLimpiarTexto(venta.clienteNombre)}\n`;
    if (venta.clienteCedula) t += `Cedula: ${posLimpiarTexto(venta.clienteCedula)}\n`;
    if (venta.clienteTelefono) t += `Telefono: ${posLimpiarTexto(venta.clienteTelefono)}\n`;
    if (venta.clienteDireccion) t += `Direccion: ${posLimpiarTexto(venta.clienteDireccion)}\n`;
  }

  if (venta.nota) {
    t += posLinea();
    t += `Nota: ${posLimpiarTexto(venta.nota)}\n`;
  }

  t += posLinea();
  t += POS_NEGRITA_ON + 'DETALLE DE LA COMPRA' + POS_NEGRITA_OFF + '\n';
  t += posLinea();

  (venta.items || []).forEach(i => {
    t += POS_ALTO_ON + POS_NEGRITA_ON;
    posWrap(i.nombre || '', POS_ANCHO).forEach(linea => { t += linea + '\n'; });
    t += POS_ALTO_OFF + POS_NEGRITA_OFF;

    const cantidad = i.cantidad || 0;
    const totalLinea = i.total != null ? i.total : cantidad * (i.precio || 0);
    const unitario = cantidad ? totalLinea / cantidad : 0;

    const refTxt = i.ref ? `Ref:${posLimpiarTexto(i.ref)}  ` : '';
    t += `${refTxt}Cant:${cantidad}  Unit:${fmt(unitario)}\n`;

    const totalTxt = fmt(totalLinea);
    t += ''.padEnd(Math.max(1, POS_ANCHO - totalTxt.length)) + totalTxt + '\n';
  });

  t += posLinea();
  t += POS_ALTO_ON + POS_NEGRITA_ON;
  const etiquetaTotal = venta.saldoPendiente !== undefined ? 'PAGADO AHORA' : 'TOTAL A PAGAR';
  t += `${etiquetaTotal}:`.padEnd(POS_ANCHO - 12) + fmt(venta.total).padStart(12) + '\n';
  t += POS_ALTO_OFF + POS_NEGRITA_OFF;

  if (venta.saldoPendiente !== undefined) {
    t += 'FALTA POR CANCELAR:'.padEnd(POS_ANCHO - 12) + fmt(venta.saldoPendiente).padStart(12) + '\n';
  }

  if (venta.pagoRecibido !== undefined) {
    t += 'PAGO RECIBIDO:'.padEnd(POS_ANCHO - 12) + fmt(venta.pagoRecibido).padStart(12) + '\n';
    t += POS_NEGRITA_ON;
    t += 'CAMBIO:'.padEnd(POS_ANCHO - 12) + fmt(venta.cambio||0).padStart(12) + '\n';
    t += POS_NEGRITA_OFF;
  }

  t += posLinea();
  t += 'Valor en letras:\n';
  posWrap(numeroALetras(venta.total), POS_ANCHO).forEach(l => { t += l + '\n'; });
  t += `Forma de pago: ${metodoTexto}\n`;
  t += posLinea();
  t += POS_ALINEAR_CEN;
  t += posLimpiarTexto('GRACIAS POR SU COMPRA') + '\n';
  t += POS_ALINEAR_IZQ;
  t += POS_CORTE;

  return t;
}

// Conecta con QZ Tray. qz-security.js debe haberse cargado antes que app.js.
async function posConectarQZ() {
  if (typeof qz === 'undefined') {
    throw new Error('La librería de QZ Tray no cargó en la página.');
  }

  if (!window.soloAgroQZSeguridadLista) {
    throw new Error(
      'La firma de QZ Tray no está configurada. Verifica qz-security.js y Google Apps Script.'
    );
  }

  if (qz.websocket.isActive()) return;

  if (!qzConectando) {
    qzConectando = qz.websocket.connect().finally(() => {
      qzConectando = null;
    });
  }

  await qzConectando;
}

// Envía ESC/POS RAW directamente a la impresora Windows.
async function posImprimir(texto) {
  await posConectarQZ();

  const impresoras = await qz.printers.find();
  const encontrada = impresoras.find(p => String(p).trim() === POS_IMPRESORA);

  if (!encontrada) {
    throw new Error(
      'No se encontró la impresora "' + POS_IMPRESORA + '" en QZ Tray. ' +
      'Impresoras detectadas: ' +
      (impresoras.length ? impresoras.join(', ') : '(ninguna)')
    );
  }

  const config = qz.configs.create(encontrada, { encoding: POS_CODEPAGE });
  const data = [{
    type: 'raw',
    format: 'command',
    flavor: 'plain',
    data: texto
  }];

  return qz.print(config, data);
}

// =============================================
// FACTURA
// =============================================
function abrirFactura(venta) {
  facturaVentaActual = venta;
  const metodoBadge = venta.metodoPago === 'transferencia'
    ? '<span class="badge rosa">🏦 Transferencia</span>'
    : '<span class="badge verde">💵 Efectivo</span>';

  const filas = venta.items.map(i => `
    <tr>
      <td><code style="background:var(--blush-claro);padding:2px 7px;border-radius:4px;font-size:12px">${esc(i.ref||'-')}</code></td>
      <td>${esc(i.nombre)}</td>
      <td style="text-align:center">${i.cantidad}</td>
      <td style="text-align:right">${fmt(i.precio)}</td>
    </tr>`).join('');

  document.getElementById('factura-contenido').innerHTML = `
    <div style="text-align:center;margin-bottom:1.5rem;padding-bottom:1rem;border-bottom:0.5px solid var(--borde)">
      <div style="font-size:28px;color:var(--rosa);margin-bottom:6px"><i class="ti ti-sparkles"></i></div>
      <h2 style="font-family:var(--fuente-titulo);font-size:22px;color:var(--rosa-oscuro)">Crem Helado</h2>
      <p style="font-size:12px;color:var(--texto2);margin-top:4px">Inventario & Ventas</p>
    </div>
    <div style="display:flex;justify-content:space-between;margin-bottom:1rem;font-size:13px;color:var(--texto2)">
      <div><div><strong>Fecha:</strong> ${venta.fecha}</div><div><strong>Hora:</strong> ${venta.hora}</div></div>
      <div style="text-align:right"><div><strong>Método:</strong></div><div style="margin-top:4px">${metodoBadge}</div></div>
    </div>
    ${venta.clienteNombre?`<div style="background:var(--blush-claro);padding:8px 12px;border-radius:8px;font-size:13px;color:var(--texto2);margin-bottom:1rem">
      <p style="margin-bottom:2px"><strong>Cliente:</strong> ${esc(venta.clienteNombre)}</p>
      <p style="margin-bottom:2px"><strong>Cédula:</strong> ${esc(venta.clienteCedula||'-')}</p>
      ${venta.clienteTelefono?`<p style="margin-bottom:2px"><strong>Teléfono:</strong> ${esc(venta.clienteTelefono)}</p>`:''}
      ${venta.clienteDireccion?`<p><strong>Dirección:</strong> ${esc(venta.clienteDireccion)}</p>`:''}
    </div>`:''}
    ${venta.nota?`<div style="background:var(--blush-claro);padding:8px 12px;border-radius:8px;font-size:13px;color:var(--texto2);margin-bottom:1rem">📝 ${esc(venta.nota)}</div>`:''}
    <div class="tabla-wrap"><table>
      <thead><tr><th>Código</th><th>Producto</th><th style="text-align:center">Cant.</th><th style="text-align:right">Precio</th></tr></thead>
      <tbody>${filas}</tbody>
    </table></div>
    <div style="margin-top:1rem;padding-top:1rem;border-top:0.5px solid var(--borde)">
      <div style="display:flex;justify-content:space-between;font-size:18px;font-weight:600;color:var(--rosa-oscuro);font-family:var(--fuente-titulo)">
        <span>${venta.saldoPendiente!==undefined?'Pagado ahora':'Total'}</span><span>${fmt(venta.total)}</span>
      </div>
      ${venta.saldoPendiente!==undefined?`
      <div style="display:flex;justify-content:space-between;font-size:14px;font-weight:600;color:#A32D2D;margin-top:6px">
        <span>Falta por cancelar</span><span>${fmt(venta.saldoPendiente)}</span>
      </div>`:''}
      ${venta.pagoRecibido!==undefined?`
      <div style="display:flex;justify-content:space-between;font-size:13px;color:var(--texto2);margin-top:6px">
        <span>Pago recibido</span><span>${fmt(venta.pagoRecibido)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:14px;font-weight:600;color:var(--rosa-oscuro);margin-top:4px">
        <span>Cambio</span><span>${fmt(venta.cambio||0)}</span>
      </div>`:''}
    </div>
    <div style="text-align:center;margin-top:1.5rem;padding-top:1rem;border-top:0.5px solid var(--borde);font-size:12px;color:var(--texto3)">¡Gracias por tu compra! 🌸</div>
  `;
  abrirModal('modal-factura');
}

// Boucher de impresión — no muestra ganancias
// Respaldo de siempre: construye el boucher en HTML y lo manda al diálogo
// de impresión del navegador (window.print()). Es EXACTAMENTE el mismo
// código que había antes en imprimirBoucher() — solo se le cambió el
// nombre, para poder usarlo como respaldo cuando la impresión térmica POS
// (más abajo) no esté disponible.
// Logos de la remisión incrustados (no dependen de archivos externos)
const LOGO_DISTRI = 'data:image/png;base64,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';
const LOGO_CREM = 'data:image/png;base64,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';

function imprimirBoucherHTML(venta) {
  const metodoTexto = venta.metodoPago === 'transferencia' ? 'Transferencia'
    : venta.metodoPago === 'mixto' ? 'Combinado (efectivo + transferencia)' : 'Efectivo';

  // Formato de la remisión de papel de Distri Helados Arauquita
  const MIN_FILAS = 14;
  const filas = venta.items.map(i => `
    <tr>
      <td class="c">${i.cantidad}</td>
      <td>${esc(i.nombre)}</td>
      <td class="r">${fmt(i.precio)}</td>
      <td class="r tot">${fmt(i.total != null ? i.total : i.precio * i.cantidad)}</td>
    </tr>`).join('');
  const vacias = Math.max(0, MIN_FILAS - venta.items.length);
  const filasVacias = Array.from({ length: vacias }, () => `<tr><td class="c">&nbsp;</td><td></td><td></td><td class="tot"></td></tr>`).join('');

  const partes = String(venta.fecha || '').split('/');
  let numero = DB.ventas.findIndex(v => v.id === venta.id) + 1;
  if (numero <= 0) numero = DB.ventas.length + 1;
  const numeroTxt = String(numero).padStart(4, '0');

  document.getElementById('venta-print-contenido').innerHTML = `
  <div class="rem">
    <div class="rem-cab">
      <img src="${LOGO_DISTRI}" alt="Distri Helados" class="rem-logo">
      <div class="rem-titulo">
        <div class="t1">COMERCIALIZADORA</div>
        <div class="t2">DISTRI HELADOS</div>
        <div class="t3">ARAUQUITA</div>
        <div class="t4">PUNTO DE VENTA AUTORIZADO</div>
      </div>
      <img src="${LOGO_CREM}" alt="Crem Helado" class="rem-logo">
    </div>
    <div class="rem-dir">Cra. 5 N° 4 - 20 / Barrio Charala / Cel. 313 8841346 / Arauquita - Arauca</div>

    <div class="rem-fila1">
      <table class="rem-fecha"><tr><th colspan="3">FECHA</th></tr>
        <tr><th>DÍA</th><th>MES</th><th>AÑO</th></tr>
        <tr><td>${partes[0]||''}</td><td>${partes[1]||''}</td><td>${partes[2]||''}</td></tr></table>
      <div class="rem-nombre">REMISIÓN</div>
      <div class="rem-numero">${numeroTxt}</div>
    </div>

    <div class="rem-cliente">
      <div class="rc-a">
        <div><span>Señor(es):</span> ${esc(venta.clienteNombre||'')}</div>
        <div><span>Dirección:</span> ${esc(venta.clienteDireccion||'')}</div>
      </div>
      <div class="rc-b">
        <div><span>NIT:</span> ${esc(venta.clienteCedula||'')}</div>
        <div><span>TEL:</span> ${esc(venta.clienteTelefono||'')}</div>
      </div>
    </div>

    <table class="rem-items">
      <thead><tr><th class="c">CANT.</th><th>DESCRIPCIÓN</th><th>VR. UNIT.</th><th>VR. TOTAL</th></tr></thead>
      <tbody>${filas}${filasVacias}</tbody>
      <tfoot>
        ${venta.saldoPendiente!==undefined?`<tr><td colspan="3" class="r">PAGADO AHORA</td><td class="r tot">${fmt(venta.total)}</td></tr>
        <tr><td colspan="3" class="r">FALTA POR CANCELAR</td><td class="r tot">${fmt(venta.saldoPendiente)}</td></tr>`
        :`<tr><td colspan="3" class="r total-l">TOTAL $</td><td class="r tot total-v">${fmt(venta.total)}</td></tr>`}
      </tfoot>
    </table>
    <div class="rem-pie-info">Pago: ${metodoTexto}${venta.nota?' · Nota: '+esc(venta.nota):''}${venta.pagoRecibido!==undefined?' · Recibido: '+fmt(venta.pagoRecibido)+' · Cambio: '+fmt(venta.cambio||0):''}</div>

    <div class="rem-firmas">
      <div class="rf-v">Firma del Vendedor</div>
      <div class="rf-c">Firma Cliente:<div class="rf-cc">C.C./ NIT:</div></div>
    </div>
  </div>
  `;

  // Los logos se cargan al insertar el HTML; si se imprime de inmediato el
  // diálogo se abre antes de que terminen de cargar y salen en blanco.
  const imgs = Array.from(document.querySelectorAll('#venta-print-contenido img'));
  Promise.all(imgs.map(im => (im.complete && im.naturalWidth > 0) ? Promise.resolve() : new Promise(res => {
    im.onload = im.onerror = res;
    setTimeout(res, 3000);
  }))).then(() => {
    prepararImpresion('venta-print');
    window.print();
  });
}

// NUEVO — imprimirBoucher(venta) ahora intenta primero la impresión térmica
// POS (QZ Tray + ESC/POS, ticket de 72mm con corte automático). Si QZ Tray
// no está instalado, no está corriendo, o la impresora POS_IMPRESORA no
// aparece, cae automáticamente al respaldo de siempre (imprimirBoucherHTML,
// ventana de impresión de Chrome) para que nunca se quede sin poder
// imprimir. Se mantiene el mismo nombre de función para no tener que tocar
// ningún otro lugar del código que ya llama a imprimirBoucher(venta).
async function imprimirBoucher(venta) {
  // Sin QZ Tray (librería no cargada) se usa la impresión normal del navegador.
  if (typeof qz === 'undefined') { imprimirBoucherHTML(venta); return; }
  try {
    const ticket = construirTicketVentaPOS(venta);
    await posImprimir(ticket);
    mostrarToast('Ticket enviado a la impresora ✓');
  } catch (err) {
    console.error('Error de impresión POS USB:', err);
    const motivo = err && err.message ? err.message : String(err);
    mostrarToast('No se pudo imprimir el ticket');
    alert(
      'NO SE PUDO IMPRIMIR EL TICKET POS.\n\n' +
      motivo + '\n\n' +
      'Verifica que QZ Tray esté ejecutándose y que la impresora "' + POS_IMPRESORA +
      '" esté encendida y conectada por USB.'
    );
  }
}

// NUEVO — botón de diagnóstico en Config ("Probar impresora"). Manda un
// ticket corto de prueba y explica con alert() exactamente qué falló, para
// poder revisar la conexión con QZ Tray sin depender de la consola del
// navegador. No se usa durante una venta real: solo cuando el usuario
// aprieta el botón de prueba.
async function probarImpresoraPOS() {
  try {
    await posConectarQZ();

    const impresoras = await qz.printers.find();
    const encontrada = impresoras.some(p => String(p).trim() === POS_IMPRESORA);

    if (!encontrada) {
      alert(
        'QZ Tray SÍ está conectado, pero Windows no tiene ninguna impresora llamada exactamente "' + POS_IMPRESORA + '".\n\n' +
        'Impresoras que Windows sí tiene instaladas:\n' + (impresoras.length ? impresoras.join('\n') : '(ninguna)') + '\n\n' +
        'Revisa el nombre exacto de la impresora en Windows (Configuración > Impresoras) y que coincida con POS_IMPRESORA en app.js.'
      );
      return;
    }

    let ticket = POS_INIT + POS_ALINEAR_CEN + POS_NEGRITA_ON;
    ticket += posLimpiarTexto('PRUEBA DE IMPRESORA') + '\n' + POS_NEGRITA_OFF;
    ticket += posLimpiarTexto('Crem Helado') + '\n';
    ticket += POS_ALINEAR_IZQ + posLinea();
    ticket += 'Si ves este ticket impreso\ncorrectamente, la impresora\nquedo bien configurada.\n';
    ticket += posLinea() + POS_CORTE;

    await posImprimir(ticket);
    alert('✓ Ticket de prueba enviado a "' + POS_IMPRESORA + '". Si no salió nada en la impresora física, revisa el cable USB y que esté encendida.');

  } catch (err) {
    alert(
      '✗ No se pudo conectar con la impresora térmica.\n\n' +
      'Motivo: ' + (err && err.message ? err.message : err) + '\n\n' +
      'Revisa que:\n' +
      '1. QZ Tray esté instalado y CORRIENDO (ícono junto al reloj de Windows, no solo instalado).\n' +
      '2. Hayas dado clic en "Allow"/"Permitir" en el aviso que muestra QZ Tray la primera vez que esta página se conecta.\n' +
      '3. La impresora "' + POS_IMPRESORA + '" esté encendida y conectada por USB.'
    );
  }
}

// =============================================
// INVENTARIO
// =============================================
function renderInventario() {
  const q = document.getElementById('inv-search').value.toLowerCase();
  const prods = DB.productos.filter(p => productoCoincideTexto(p, q));
  const cont = document.getElementById('inv-contenido');

  if (prods.length === 0) {
    cont.innerHTML = `<div class="estado-vacio"><i class="ti ti-package"></i><p>Sin productos.</p></div>`;
    return;
  }

  const visibles = prods.slice(0, inventarioMostrar);
  const filas = visibles.map(p => {
    const badge = p.stock<=0 ? '<span class="badge danger">Sin stock</span>'
      : p.stock<=DB.config.stockMin ? '<span class="badge alerta">Stock bajo</span>'
      : '<span class="badge ok">OK</span>';
    const pc = precioCompraVisible
      ? fmt(p.pcompra)
      : `<span class="precio-oculto" data-id="${p.id}">${fmt(p.pcompra)}</span>`;
    return `<tr>
      <td><code style="background:var(--blush-claro);padding:2px 7px;border-radius:4px;font-size:12px">${esc(p.ref)}</code></td>
      <td>${esc(p.nombre)}</td><td>${pc}</td>
      <td>${fmt(p.pventa1)}</td><td>${p.pventa2?fmt(p.pventa2):'-'}</td>
      <td>${p.stock} ${badge}</td>
      <td><div style="display:flex;gap:6px">
        <button class="btn-secundario btn-editar-producto" data-id="${p.id}" style="padding:6px 10px"><i class="ti ti-edit"></i></button>
        <button class="btn-secundario btn-imprimir-etiqueta" data-id="${p.id}" style="padding:6px 10px" title="Imprimir etiqueta de código de barras"><i class="ti ti-barcode"></i></button>
        <button class="btn-peligro btn-eliminar-producto" data-id="${p.id}" style="padding:6px 10px"><i class="ti ti-trash"></i></button>
      </div></td>
    </tr>`;
  }).join('');

  const valorTotalMercancia = prods.reduce((acc, p) => acc + (p.pcompra || 0) * (p.stock || 0), 0);

  cont.innerHTML = `<div class="tabla-wrap"><table>
    <thead><tr><th>Ref</th><th>Nombre</th><th>P.Compra <i class="ti ti-lock" style="font-size:10px"></i></th><th>P.Venta 1</th><th>P.Venta 2</th><th>Stock</th><th>Acciones</th></tr></thead>
    <tbody>${filas}</tbody></table></div>
    ${prods.length>inventarioMostrar?`<button class="btn-secundario" id="btn-ver-mas-inventario" style="width:100%;margin-top:10px">Ver más productos (${prods.length-inventarioMostrar} restantes)</button>`:''}
    <div style="margin-top:14px;padding:12px 16px;background:var(--rosa-claro);border-radius:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <span style="color:var(--rosa-oscuro);font-weight:500">Valor total en mercancía (según precio de compra)</span>
      <span style="font-size:18px;font-weight:700">${fmt(valorTotalMercancia)}</span>
    </div>`;

  cont.querySelectorAll('.btn-editar-producto').forEach(b => b.addEventListener('click', () => abrirModalProducto(b.dataset.id)));
  cont.querySelectorAll('.btn-imprimir-etiqueta').forEach(b => b.addEventListener('click', () => imprimirEtiquetaProducto(b.dataset.id)));
  cont.querySelectorAll('.btn-eliminar-producto').forEach(b => b.addEventListener('click', () => eliminarProducto(b.dataset.id)));
  cont.querySelectorAll('.precio-oculto').forEach(b => b.addEventListener('click', pedirPin));
  const btnVerMas = document.getElementById('btn-ver-mas-inventario');
  if (btnVerMas) btnVerMas.addEventListener('click', () => { inventarioMostrar += 10; renderInventario(); });
}

// =============================================
// IMPRIMIR ETIQUETA DE CÓDIGO DE BARRAS
// =============================================
// Para los repuestos que NO traen código de barras de fábrica: se genera
// uno propio a partir de la Ref del producto (que ya es única para cada
// producto) y se imprime en una etiqueta chiquita con el nombre y el
// precio. Se pega esa etiqueta al producto o a su lugar en la repisa, y de
// ahí en adelante se escanea igual que cualquier otro código.
// Si el producto SÍ tiene guardado un código de barras de fábrica, se
// imprime ese en vez de inventar uno nuevo.
function imprimirEtiquetaProducto(id) {
  const p = DB.productos.find(x => x.id === id);
  if (!p) return;

  const codigo = (p.codigoBarras && p.codigoBarras.trim()) ? p.codigoBarras.trim() : p.ref;
  if (!codigo) { alert('Este producto no tiene Ref ni código de barras para imprimir.'); return; }

  const ventana = window.open('', '_blank', 'width=420,height=320');
  if (!ventana) { alert('El navegador bloqueó la ventana de impresión. Permite las ventanas emergentes para este sitio e intenta de nuevo.'); return; }

  ventana.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Etiqueta — ${esc(p.nombre)}</title>
      <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
      <style>
        @page { margin: 4mm; }
        body { font-family: Arial, sans-serif; text-align: center; margin: 0; padding: 10px; }
        .etiqueta { display: inline-block; border: 1px dashed #ccc; padding: 8px 12px; }
        .nombre { font-size: 12px; font-weight: bold; margin-bottom: 2px; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .precio { font-size: 14px; font-weight: bold; margin-top: 2px; }
      </style>
    </head>
    <body>
      <div class="etiqueta">
        <div class="nombre">${esc(p.nombre)}</div>
        <svg id="barras"></svg>
        <div class="precio">${fmt(p.pventa1)}</div>
      </div>
      <script>
        try {
          JsBarcode("#barras", ${JSON.stringify(codigo)}, { format: "CODE128", width: 2, height: 50, fontSize: 14, margin: 4 });
        } catch (e) {
          document.body.innerHTML = '<p style="color:red">No se pudo generar el código de barras: ' + e + '</p>';
        }
        window.onload = () => setTimeout(() => window.print(), 300);
      <\/script>
    </body>
    </html>
  `);
  ventana.document.close();
}

function abrirModalProducto(id, codigoBarrasPrellenado) {
  editandoProductoId = id || null;
  document.getElementById('modal-prod-titulo').textContent = id ? 'Editar producto' : 'Agregar producto';
  if (id) {
    const p = DB.productos.find(x => x.id === id);
    if (!p) return;
    document.getElementById('prod-codigobarras').value = p.codigoBarras||'';
    document.getElementById('prod-ref').value     = p.ref;
    document.getElementById('prod-nombre').value  = p.nombre;
    document.getElementById('prod-pcompra').value = p.pcompra;
    document.getElementById('prod-pventa1').value = p.pventa1;
    document.getElementById('prod-pventa2').value = p.pventa2||'';
    document.getElementById('prod-stock').value   = p.stock;
  } else {
    ['prod-codigobarras','prod-ref','prod-nombre','prod-pcompra','prod-pventa1','prod-pventa2','prod-stock'].forEach(x => document.getElementById(x).value='');
    // Si se llega aquí desde un escaneo de un código de fábrica que no
    // existe todavía, se deja ya escrito para no tener que digitarlo.
    if (codigoBarrasPrellenado) document.getElementById('prod-codigobarras').value = codigoBarrasPrellenado;
  }
  abrirModal('modal-producto');
  if (!id) setTimeout(() => document.getElementById(codigoBarrasPrellenado ? 'prod-ref' : 'prod-codigobarras').focus(), 100);
}

async function guardarProducto() {
  const codigoBarras=document.getElementById('prod-codigobarras').value.trim();
  const ref=document.getElementById('prod-ref').value.trim();
  const nombre=document.getElementById('prod-nombre').value.trim();
  const pcompra=parseFloat(document.getElementById('prod-pcompra').value)||0;
  const pventa1=parseFloat(document.getElementById('prod-pventa1').value)||0;
  const pventa2=parseFloat(document.getElementById('prod-pventa2').value)||0;
  const stock=parseInt(document.getElementById('prod-stock').value)||0;
  if (!ref||!nombre||!pventa1) { alert('Completa los campos obligatorios (*)'); return; }

  const btn = document.getElementById('btn-guardar-producto');
  btn.textContent='Guardando...'; btn.disabled=true;

  if (editandoProductoId) {
    const p = DB.productos.find(x => x.id===editandoProductoId);
    if (p) {
      Object.assign(p,{ref,nombre,pcompra,pventa1,pventa2,stock,codigoBarras});
      // Columnas A-G (Ref..Stock): igual que siempre.
      await sheetsEscribir('update','Productos',[p.id,p.ref,p.nombre,p.pcompra,p.pventa1,p.pventa2,p.stock],p.id);
      // Columna J (código de barras): en una llamada aparte, para no pisar
      // las columnas H (alegraId) e I (unidadOK) que usa la integración
      // con Alegra y que aquí no conocemos su valor actual.
      await sheetsEscribir('update','Productos',[p.codigoBarras||''],p.id,10);
    }
  } else {
    const nuevo={id:uid(),ref,nombre,pcompra,pventa1,pventa2,stock,codigoBarras};
    DB.productos.push(nuevo);
    // H y I se dejan en blanco (las llena la integración con Alegra); J es
    // el código de barras.
    await sheetsEscribir('append','Productos',[nuevo.id,nuevo.ref,nuevo.nombre,nuevo.pcompra,nuevo.pventa1,nuevo.pventa2,nuevo.stock,'','',nuevo.codigoBarras||'']);
  }

  guardarLocal(); btn.textContent='Guardar'; btn.disabled=false;
  cerrarModal('modal-producto'); renderInventario();
  mostrarToast(editandoProductoId?'Producto actualizado ✓':'Producto agregado ✓');
}

async function eliminarProducto(id) {
  if (!confirm('¿Eliminar este producto?')) return;
  await sheetsEscribir('delete','Productos',null,id);
  DB.productos = DB.productos.filter(p => p.id!==id);
  guardarLocal(); renderInventario(); mostrarToast('Producto eliminado');
}

// PIN
function pedirPin() {
  document.getElementById('pin-input').value='';
  document.getElementById('pin-error').classList.add('hidden');
  abrirModal('modal-pin');
}
function verificarPin() {
  const p = document.getElementById('pin-input').value;
  const admin = DB.usuarios.find(u => u.rol==='admin' && u.pass===p);
  if (admin) { precioCompraVisible=true; cerrarModal('modal-pin'); renderInventario(); }
  else document.getElementById('pin-error').classList.remove('hidden');
}

// =============================================
// VENTAS — FLUJO RÁPIDO PUNTO 1
// =============================================
function buscarProductoVenta() {
  const q = document.getElementById('venta-search').value.toLowerCase();
  const cont = document.getElementById('venta-resultados');
  indiceVenta = 0;
  ventaResultadosMostrar = 8;
  if (!q) { cont.innerHTML=''; resultadosVenta=[]; resultadosVentaTodos=[]; return; }

  resultadosVentaTodos = DB.productos
    .filter(p => productoCoincideTexto(p, q));

  if (resultadosVentaTodos.length===0) { cont.innerHTML='<p style="font-size:13px;color:var(--texto2);padding:8px 0">Sin resultados</p>'; resultadosVenta=[]; return; }

  actualizarResultadosVentaVisibles();
}

function actualizarResultadosVentaVisibles() {
  resultadosVenta = resultadosVentaTodos.slice(0, ventaResultadosMostrar);
  renderResultadosVenta();
}

function renderResultadosVenta() {
  const cont = document.getElementById('venta-resultados');
  const quedan = resultadosVentaTodos.length - resultadosVenta.length;
  cont.innerHTML = `
    <div style="background:var(--card);border:0.5px solid var(--borde);border-radius:12px;overflow:hidden;margin-bottom:1rem;box-shadow:0 4px 16px rgba(31,122,77,0.12)">
      <div style="padding:8px 12px;background:var(--blush-claro);border-bottom:0.5px solid var(--borde);font-size:11px;color:var(--texto2);font-weight:500;text-transform:uppercase;letter-spacing:0.5px">
        Resultados — ↑↓ para navegar, Enter para seleccionar
      </div>
      ${resultadosVenta.map((p,i) => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:0.5px solid var(--borde);flex-wrap:wrap;gap:8px;${i===indiceVenta?'background:var(--rosa-claro)':''}">
          <div>
            ${i===indiceVenta?'<span style="font-size:10px;background:var(--rosa);color:#fff;padding:2px 7px;border-radius:10px;margin-right:6px">↵ Enter</span>':''}
            <span style="font-size:14px;font-weight:500">${esc(p.nombre)}</span>
            <div style="font-size:12px;color:var(--texto2)">Ref: ${esc(p.ref)} · Stock: ${p.stock<=0?`<span style="color:#A32D2D;font-weight:600">${p.stock} · SIN STOCK</span>`:p.stock} · P1: ${fmt(p.pventa1)}${p.pventa2?' · P2: '+fmt(p.pventa2):''}${precioEspecialCliente(p)!=null?` · <strong style="color:var(--rosa)">Precio de ${esc(clienteVenta.nombre)}: ${fmt(precioEspecialCliente(p))}</strong>`:''}</div>
          </div>
          <button class="btn-primary btn-agregar-rapido" data-id="${p.id}" style="flex-shrink:0"><i class="ti ti-plus"></i> Agregar</button>
        </div>`).join('')}
      ${quedan>0?`<button type="button" class="btn-secundario" id="btn-ver-mas-venta" style="width:100%;border-radius:0">Ver más resultados (${quedan} restantes)</button>`:''}
    </div>`;

  cont.querySelectorAll('.btn-agregar-rapido').forEach(b =>
    b.addEventListener('click', () => abrirFlujRapido(b.dataset.id)));

  const btnVerMas = document.getElementById('btn-ver-mas-venta');
  if (btnVerMas) btnVerMas.addEventListener('click', () => { ventaResultadosMostrar += 8; actualizarResultadosVentaVisibles(); });
}

// =============================================
// LECTOR DE CÓDIGO DE BARRAS — VENTAS
// =============================================
// Un lector de código de barras USB funciona como un teclado: al escanear
// "escribe" el código muy rápido en el campo que tenga el foco y al final
// manda un Enter automático. Por eso no necesita ninguna configuración ni
// librería especial: solo hay que dejar el cursor en el buscador y detectar
// cuando lo que se tecleó coincide EXACTO con la Ref de un producto (eso
// distingue un escaneo de una búsqueda normal por nombre, donde el usuario
// usa las flechas para elegir). Si hay coincidencia exacta, se agrega al
// carrito de una vez con Precio 1 y cantidad 1, sin abrir ningún modal, para
// poder seguir escaneando el siguiente producto sin tocar el mouse.
function agregarProductoEscaneado(p) {
  const espCli = precioEspecialCliente(p);
  const precioEsc = espCli != null ? espCli : p.pventa1;
  const yaEsta = carrito.find(i => i.id===p.id && i.precio===precioEsc);
  if (yaEsta) {
    yaEsta.cantidad += 1;
    yaEsta.total = yaEsta.cantidad * yaEsta.precio;
  } else {
    carrito.push({
      id: p.id, nombre: p.nombre, ref: p.ref, pcompra: p.pcompra,
      precio: precioEsc, pventa1: p.pventa1, pventa2: p.pventa2,
      cantidad: 1, total: precioEsc, precioCliente: espCli != null
    });
  }

  renderCarrito();
  mostrarToast(`${p.nombre} agregado (escaneado) ✓`);

  document.getElementById('venta-search').value = '';
  document.getElementById('venta-resultados').innerHTML = '';
  resultadosVenta = []; resultadosVentaTodos = [];
  document.getElementById('venta-search').focus();
}

// Flujo rápido: abre modal con cantidad
function abrirFlujRapido(id) {
  const p = DB.productos.find(x => x.id===id);
  if (!p) return;
  rapidoProductoActual = p;

  document.getElementById('rapido-nombre').textContent = p.nombre;
  document.getElementById('rapido-cantidad').value = '1';
  document.getElementById('rapido-paso-cantidad').classList.remove('hidden');
  document.getElementById('rapido-paso-precio').classList.add('hidden');

  abrirModal('modal-rapido');
  setTimeout(() => document.getElementById('rapido-cantidad').focus(), 100);

  // Limpiar búsqueda al abrir
  document.getElementById('venta-search').value = '';
  document.getElementById('venta-resultados').innerHTML = '';
  resultadosVenta = [];
}

// Paso 2: mostrar precios
function rapidoMostrarPrecio() {
  const cant = parseInt(document.getElementById('rapido-cantidad').value)||1;
  if (cant < 1) return;

  const p = rapidoProductoActual;
  // Sin límite por stock: se puede vender aunque el inventario quede en negativo.

  // Si el cliente tiene precio especial para este producto, se agrega directo con ese precio.
  const espCliente = precioEspecialCliente(p);
  if (espCliente != null) { rapidoAgregarConPrecio(espCliente); return; }

  document.getElementById('rapido-paso-cantidad').classList.add('hidden');
  document.getElementById('rapido-paso-precio').classList.remove('hidden');

  const btn1 = document.getElementById('rapido-btn-p1');
  btn1.innerHTML = `<span>Precio 1 — normal</span><strong>${fmt(p.pventa1)}</strong>`;

  const btn2 = document.getElementById('rapido-btn-p2');
  if (p.pventa2) {
    btn2.innerHTML = `<span>Precio 2 — especial</span><strong>${fmt(p.pventa2)}</strong>`;
    btn2.disabled = false;
    btn2.style.opacity = '1';
  } else {
    btn2.innerHTML = `<span>Precio 2</span><span style="color:var(--texto3)">No definido</span>`;
    btn2.disabled = true;
    btn2.style.opacity = '0.4';
  }

  document.getElementById('rapido-precio-custom').value = '';
  setTimeout(() => document.getElementById('rapido-btn-p1').focus(), 100);
}

function cantidadEnCarrito(id) {
  return carrito.filter(i => i.id===id).reduce((a,i) => a+i.cantidad, 0);
}

// Agregar al carrito desde flujo rápido
function rapidoAgregarConPrecio(precio) {
  const p = rapidoProductoActual;
  const cant = parseInt(document.getElementById('rapido-cantidad').value)||1;

  const yaEsta = carrito.find(i => i.id===p.id && i.precio===precio);
  if (yaEsta) {
    yaEsta.cantidad += cant;
    yaEsta.total = yaEsta.cantidad * yaEsta.precio;
  } else {
    carrito.push({
      id: p.id, nombre: p.nombre, ref: p.ref, pcompra: p.pcompra,
      precio, pventa1: p.pventa1, pventa2: p.pventa2,
      cantidad: cant, total: precio * cant,
      precioCliente: precioEspecialCliente(p) === precio
    });
  }

  cerrarModal('modal-rapido');
  renderCarrito();
  mostrarToast(`${p.nombre} agregado al carrito ✓`);

  // Volver al buscador automáticamente
  setTimeout(() => document.getElementById('venta-search').focus(), 150);
}

function renderCarrito() {
  const cont   = document.getElementById('carrito');
  const footer = document.getElementById('venta-footer');

  if (carrito.length===0) { cont.innerHTML=''; footer.classList.add('hidden'); return; }
  footer.classList.remove('hidden');

  cont.innerHTML = `
    <div style="background:var(--card);border:0.5px solid var(--borde);border-radius:12px;overflow:hidden;margin-bottom:1rem">
      <div style="padding:8px 12px;background:var(--rosa-claro);border-bottom:0.5px solid var(--borde);font-size:11px;color:var(--rosa-oscuro);font-weight:500;text-transform:uppercase;letter-spacing:0.5px">
        🛒 Productos en el carrito (${carrito.length})
      </div>
      ${carrito.map((item,idx) => `
        <div class="carrito-item" style="border-radius:0;border-left:none;border-right:none;border-top:none">
          <div class="item-nombre">
            <strong>${esc(item.nombre)}</strong>
            <span>Ref: ${esc(item.ref)}${item.precioCliente&&clienteVenta?` · <b style="color:var(--rosa)">precio de ${esc(clienteVenta.nombre)}</b>`:''}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <input type="number" value="${item.cantidad}" min="1" class="input-cantidad-carrito" data-idx="${idx}">
            <button class="btn-dorado btn-cambiar-precio" data-idx="${idx}"><i class="ti ti-tag"></i> ${fmt(item.precio)}</button>
            <span class="item-total">${fmt(item.total)}</span>
            <button class="btn-peligro btn-quitar-carrito" data-idx="${idx}" style="padding:6px 10px"><i class="ti ti-x"></i></button>
          </div>
        </div>`).join('')}
    </div>`;

  document.getElementById('vt-total').textContent = fmt(carrito.reduce((a,i)=>a+i.total,0));

  cont.querySelectorAll('.input-cantidad-carrito').forEach(input => {
    input.addEventListener('change', () => {
      const idx = parseInt(input.dataset.idx);
      const item = carrito[idx];
      // Sin límite por stock: se puede vender aunque el inventario quede en negativo.
      let nuevaCant = Math.max(1, parseInt(input.value)||1);
      item.cantidad = nuevaCant;
      item.total = item.cantidad * item.precio;
      renderCarrito();
    });
  });

  cont.querySelectorAll('.btn-cambiar-precio').forEach(b =>
    b.addEventListener('click', () => abrirModalPrecio(parseInt(b.dataset.idx))));

  cont.querySelectorAll('.btn-quitar-carrito').forEach(b =>
    b.addEventListener('click', () => { carrito.splice(parseInt(b.dataset.idx),1); renderCarrito(); }));
}

function abrirModalPrecio(idx) {
  carritoItemEditando = idx;
  const item = carrito[idx];
  document.getElementById('mpv-nombre-producto').textContent = item.nombre;
  const b1 = document.getElementById('mpv-btn-precio1');
  b1.textContent=`Precio 1 — normal: ${fmt(item.pventa1)}`; b1.className='btn-secundario';
  const b2 = document.getElementById('mpv-btn-precio2');
  b2.textContent = item.pventa2?`Precio 2 — especial: ${fmt(item.pventa2)}`:'Precio 2 — no definido';
  b2.disabled = !item.pventa2; b2.className='btn-secundario';
  document.getElementById('mpv-precio-custom').value='';
  abrirModal('modal-precio');
  setTimeout(() => document.getElementById('mpv-btn-precio1').focus(), 100);
}

function seleccionarPrecio(n) {
  const item = carrito[carritoItemEditando];
  item.precio = n===1?item.pventa1:item.pventa2;
  item.precioCliente = false;
  item.total  = item.cantidad*item.precio;
  cerrarModal('modal-precio'); renderCarrito();
}

function aplicarPrecioCustom() {
  const v = parseFloat(document.getElementById('mpv-precio-custom').value);
  if (!v||v<0) { alert('Ingresa un precio válido'); return; }
  const item = carrito[carritoItemEditando];
  item.precio=v; item.precioCliente=false; item.total=item.cantidad*v;
  cerrarModal('modal-precio'); renderCarrito();
}

// Punto de entrada del botón "Confirmar venta". Si el pago es en efectivo,
// primero pregunta con cuánto paga el cliente (para calcular el cambio) antes
// de guardar nada; con transferencia o pago mixto no hace falta ese paso y la
// venta se guarda de una vez — esto, sumado a ya no depender de ninguna
// llamada a un servicio externo de facturación, es lo que hace el proceso de
// venta notablemente más rápido.
function confirmarVenta() {
  if (carrito.length===0) return;
  const total=carrito.reduce((a,i)=>a+i.total,0);
  const metodoPago=document.querySelector('input[name="metodo-pago"]:checked').value;

  if (metodoPago === 'mixto') {
    const efectivo = parseFloat(document.getElementById('pago-mixto-efectivo').value)||0;
    const transferencia = parseFloat(document.getElementById('pago-mixto-transferencia').value)||0;
    if (Math.round(efectivo+transferencia) !== Math.round(total)) {
      alert('El pago mixto no cuadra con el total de la venta.');
      return;
    }
  }

  if (metodoPago === 'efectivo') {
    abrirModalPagoEfectivo(total);
  } else {
    finalizarVenta(null);
  }
}

// =============================================
// COBRO EN EFECTIVO (con cuánto paga / vueltos)
// =============================================
let pagoEfectivoTotalActual = 0;

// Opciones rápidas de billetes: el total mismo, y el total redondeado hacia
// arriba a la siguiente denominación común (5.000, 10.000, 50.000), sin
// repetir valores. Ej: total 35.000 -> 35.000, 40.000, 50.000.
function calcularOpcionesRapidasPago(total) {
  const candidatos = [
    total,
    Math.ceil(total/5000)*5000,
    Math.ceil(total/10000)*10000,
    Math.ceil(total/50000)*50000,
    100000
  ];
  const vistos = new Set();
  const opciones = [];
  candidatos.forEach(v => { if (v>0 && v>=total && !vistos.has(v)) { vistos.add(v); opciones.push(v); } });
  opciones.sort((a,b)=>a-b);
  return opciones.slice(0,5);
}

function abrirModalPagoEfectivo(total) {
  pagoEfectivoTotalActual = total;
  document.getElementById('pef-total').textContent = fmt(total);
  const input = document.getElementById('pef-recibido');
  input.value = total;
  renderOpcionesRapidasPago(total);
  actualizarCambioPago();
  abrirModal('modal-pago-efectivo');
  setTimeout(() => { input.focus(); input.select(); }, 100);
}

function renderOpcionesRapidasPago(total) {
  const opciones = calcularOpcionesRapidasPago(total);
  const cont = document.getElementById('pef-opciones-rapidas');
  cont.innerHTML = opciones.map(v => `<button type="button" class="pef-opcion-rapida" data-valor="${v}">${fmt(v)}</button>`).join('');
  cont.querySelectorAll('.pef-opcion-rapida').forEach(b => {
    b.addEventListener('click', () => {
      document.getElementById('pef-recibido').value = b.dataset.valor;
      actualizarCambioPago();
    });
  });
}

function actualizarCambioPago() {
  const recibido = parseFloat(document.getElementById('pef-recibido').value)||0;
  const cambio = recibido - pagoEfectivoTotalActual;
  const elCambio = document.getElementById('pef-cambio');
  elCambio.textContent = fmt(Math.max(0,cambio));
  elCambio.classList.toggle('negativo', cambio < 0);
  const btn = document.getElementById('btn-pef-continuar');
  if (btn) btn.disabled = cambio < 0;

  document.querySelectorAll('.pef-opcion-rapida').forEach(b => {
    b.classList.toggle('activa', Number(b.dataset.valor) === recibido);
  });
}

function confirmarPagoEfectivo() {
  const recibido = parseFloat(document.getElementById('pef-recibido').value)||0;
  if (recibido < pagoEfectivoTotalActual) { alert('El valor recibido no puede ser menor al total de la venta.'); return; }
  cerrarModal('modal-pago-efectivo');
  finalizarVenta(recibido);
}

// Guarda la venta de verdad. pagoEfectivoRecibido es el valor con el que
// pagó el cliente (solo para método "efectivo"; en los demás métodos llega
// null y no se calcula ni se muestra cambio).
async function finalizarVenta(pagoEfectivoRecibido) {
  const ahora=new Date();
  const fecha=fechaCO(ahora);
  const hora=horaCO(ahora);
  const total=carrito.reduce((a,i)=>a+i.total,0);
  const ganancia=carrito.reduce((a,i)=>a+(i.precio-i.pcompra)*i.cantidad,0);
  const nota=document.getElementById('venta-nota').value.trim();
  const metodoPago=document.querySelector('input[name="metodo-pago"]:checked').value;
  const cambio = pagoEfectivoRecibido!=null ? Math.max(0, pagoEfectivoRecibido-total) : undefined;

  // El stock puede quedar en negativo a propósito: si vendes algo que no
  // tenías registrado en el sistema, la venta no se bloquea. El faltante
  // queda visible como stock negativo hasta que ingreses la mercancía.
  for (const item of carrito) {
    const p = DB.productos.find(x=>x.id===item.id);
    if (p) {
      p.stock = p.stock - item.cantidad;
      await sheetsEscribir('update','Productos',[p.id,p.ref,p.nombre,p.pcompra,p.pventa1,p.pventa2,p.stock],p.id);
    }
  }

  const venta={
    id:uid(),fecha,hora,total,ganancia,nota,metodoPago,items:carrito.map(i=>({...i})),
    clienteId: clienteVenta?clienteVenta.id:'', clienteNombre: clienteVenta?clienteVenta.nombre:'',
    clienteCedula: clienteVenta?clienteVenta.cedula:'', clienteTelefono: clienteVenta?clienteVenta.telefono:'',
    clienteDireccion: clienteVenta?clienteVenta.direccion:'',
    pagoRecibido: pagoEfectivoRecibido!=null?pagoEfectivoRecibido:undefined, cambio,
    pagoEf: metodoPago==='mixto' ? (parseFloat(document.getElementById('pago-mixto-efectivo').value)||0) : undefined,
    pagoTr: metodoPago==='mixto' ? (parseFloat(document.getElementById('pago-mixto-transferencia').value)||0) : undefined
  };
  DB.ventas.push(venta);
  await sheetsEscribir('append','Ventas',[venta.id,venta.fecha,venta.hora,venta.total,venta.ganancia,venta.nota,venta.metodoPago,JSON.stringify(venta.items),venta.clienteId,venta.clienteNombre,venta.clienteCedula,venta.clienteTelefono,venta.clienteDireccion,'','',venta.pagoRecibido!=null?venta.pagoRecibido:'',venta.cambio!=null?venta.cambio:'',venta.pagoEf!=null?venta.pagoEf:'',venta.pagoTr!=null?venta.pagoTr:'']);

  guardarLocal();
  mostrarToast(`Venta registrada · ${metodoPago==='transferencia'?'🏦':metodoPago==='mixto'?'🔀':'💵'} ${fmt(total)}`);

  imprimirBoucher(venta);

  carrito=[];
  renderCarrito();
  quitarClienteVenta();
  document.getElementById('venta-cliente-buscar').value='';
  document.getElementById('venta-cliente-resultados').innerHTML='';
  document.getElementById('venta-search').value='';
  document.getElementById('venta-resultados').innerHTML='';
  resultadosVenta=[];
  document.getElementById('venta-nota').value='';
  document.querySelector('input[name="metodo-pago"][value="efectivo"]').checked=true;
  document.getElementById('pago-mixto-box').classList.add('hidden');
  document.getElementById('pago-mixto-efectivo').value=0;
  document.getElementById('pago-mixto-transferencia').value=0;
  setTimeout(()=>document.getElementById('venta-search').focus(),150);
}

// =============================================
// HISTORIAL
// =============================================
function renderHistorial() {
  const fechaISO=document.getElementById('hist-fecha').value;
  const fecha=isoAFechaCO(fechaISO);
  const ventas=DB.ventas.filter(v=>v.fecha===fecha).slice().reverse();
  const summary=document.getElementById('hist-summary');
  const cont=document.getElementById('hist-contenido');

  if (ventas.length===0) {
    summary.innerHTML='';
    cont.innerHTML=`<div class="estado-vacio"><i class="ti ti-history"></i><p>Sin ventas en esta fecha</p></div>`;
    return;
  }

  const totalDia=ventas.reduce((a,v)=>a+v.total,0);
  const efectivo=ventas.reduce((a,v)=>a+partesVenta(v).ef,0);
  const transferencia=ventas.reduce((a,v)=>a+partesVenta(v).tr,0);

  summary.innerHTML=`<div id="dash-metrics" style="margin-bottom:1rem">
    <div class="metric rosa" style="display:inline-block;margin-right:12px;margin-bottom:8px;min-width:160px"><div class="mlabel">Total vendido</div><div class="mvalue">${fmt(totalDia)}</div></div>
    <div class="metric" style="display:inline-block;margin-right:12px;margin-bottom:8px;min-width:140px"><div class="mlabel">💵 Efectivo</div><div class="mvalue">${fmt(efectivo)}</div></div>
    <div class="metric" style="display:inline-block;margin-bottom:8px;min-width:160px"><div class="mlabel">🏦 Transferencia</div><div class="mvalue">${fmt(transferencia)}</div></div>
  </div>`;

  const filas=ventas.map(v=>`
    <tr>
      <td>${v.hora}</td>
      <td style="font-size:13px">${(v.items||[]).map(i=>esc(i.nombre)+' x'+i.cantidad).join('<br>')}</td>
      <td style="font-size:13px;color:var(--texto2)">${v.nota||'-'}</td>
      <td>${badgeMetodo(v)}</td>
      <td style="font-weight:500">${fmt(v.total)}</td>
      <td style="color:var(--dorado-oscuro);font-weight:500">${fmt(v.ganancia)}</td>
      <td><div style="display:flex;gap:6px">
        <button class="btn-secundario btn-ver-factura" data-id="${v.id}" style="padding:5px 9px"><i class="ti ti-receipt"></i></button>
        <button class="btn-peligro btn-eliminar-venta" data-id="${v.id}" style="padding:5px 9px"><i class="ti ti-trash"></i></button>
      </div></td>
    </tr>`).join('');

  cont.innerHTML=`<div class="tabla-wrap"><table>
    <thead><tr><th>Hora</th><th>Productos</th><th>Nota</th><th>Pago</th><th>Total</th><th>Ganancia</th><th></th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;

  cont.querySelectorAll('.btn-ver-factura').forEach(b=>b.addEventListener('click',()=>{
    const v=DB.ventas.find(x=>x.id===b.dataset.id); if(v) abrirFactura(v);
  }));
  cont.querySelectorAll('.btn-eliminar-venta').forEach(b=>b.addEventListener('click',()=>eliminarVenta(b.dataset.id)));
}

// ANTES esta función borraba TODA la hoja de Ventas y la reconstruía fila
// por fila desde lo que hubiera cargado en el navegador (DB.ventas) — si esa
// copia local no tenía el historial completo, o el proceso se interrumpía a
// medio camino (se cerraba la pestaña, se iba el internet), se perdía todo
// lo demás. Así fue como se borraron las ventas del día y del mes.
// AHORA borra solo la fila exacta de esa venta por su ID, usando la acción
// 'delete' que el backend ya soporta — nunca toca las demás filas.
async function eliminarVenta(id) {
  if (!confirm('¿Eliminar esta venta? El stock no se restaura.')) return;

  const eliminado = await sheetsEscribir('delete','Ventas',null,id);
  if (!eliminado) {
    alert('NO SE PUDO ELIMINAR LA VENTA EN GOOGLE SHEETS.\n\nNo se quitó de tu pantalla para que puedas intentarlo de nuevo.');
    return;
  }

  DB.ventas=DB.ventas.filter(v=>v.id!==id);
  guardarLocal();
  renderHistorial(); renderDashboard(); mostrarToast('Venta eliminada');
}

// =============================================
// REPORTES — PUNTO 2
// =============================================
let reporteDiaEsp = '';   // 'AAAA-MM-DD' cuando se busca un día específico
let reporteMesEsp = '';   // 'AAAA-MM' cuando se busca un mes específico
let reporteSemEsp = '';   // 'AAAA-MM-DD' (cualquier día de la semana que se busca)
const MESES_LARGO = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const MESES_CORTO = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
const DIAS_CORTO = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];

function getRangoPeriodo(periodo) {
  const hoy = new Date();
  let desde, hasta;

  if (periodo === 'dia') {
    desde = new Date(hoy); desde.setHours(0,0,0,0);
    hasta = new Date(hoy); hasta.setHours(23,59,59,999);
  } else if (periodo === 'semana') {
    // Lunes de esta semana
    const dia = hoy.getDay();
    const diff = dia === 0 ? -6 : 1 - dia;
    desde = new Date(hoy); desde.setDate(hoy.getDate() + diff); desde.setHours(0,0,0,0);
    hasta = new Date(hoy); hasta.setHours(23,59,59,999);
  } else if (periodo === 'mes') {
    desde = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
    hasta = new Date(hoy); hasta.setHours(23,59,59,999);
  } else if (periodo === 'semana-esp') {
    const [y, m, d] = (reporteSemEsp || '').split('-').map(Number);
    const base = y ? new Date(y, m - 1, d) : new Date(hoy);
    const dow = base.getDay();
    desde = new Date(base); desde.setDate(base.getDate() + (dow === 0 ? -6 : 1 - dow)); desde.setHours(0,0,0,0);
    hasta = new Date(desde); hasta.setDate(desde.getDate() + 6); hasta.setHours(23,59,59,999);
  } else if (periodo === 'dia-esp') {
    const [y, m, d] = (reporteDiaEsp || '').split('-').map(Number);
    const base = y ? new Date(y, m - 1, d) : new Date(hoy);
    desde = new Date(base); desde.setHours(0,0,0,0);
    hasta = new Date(base); hasta.setHours(23,59,59,999);
  } else if (periodo === 'mes-esp') {
    const [y, m] = (reporteMesEsp || '').split('-').map(Number);
    const base = y ? new Date(y, m - 1, 1) : new Date(hoy.getFullYear(), hoy.getMonth(), 1);
    desde = base;
    hasta = new Date(base.getFullYear(), base.getMonth() + 1, 0, 23,59,59,999);
  } else {
    desde = new Date(hoy.getFullYear(), 0, 1);
    hasta = new Date(hoy); hasta.setHours(23,59,59,999);
  }

  return { desde, hasta };
}

function kpiHTML(cls, icono, label, valor, sub) {
  return `<div class="metric ${cls}"><div class="mtop"><span class="micon ${cls}"><i class="ti ${icono}"></i></span><span class="mlabel">${label}</span></div><div class="mvalue">${valor}</div>${sub ? `<div class="msub">${sub}</div>` : ''}</div>`;
}

function renderReportes(periodo) {
  periodoreporte = periodo;

  // Actualizar botones activos
  document.querySelectorAll('.btn-reporte').forEach(b => {
    b.classList.toggle('active', b.dataset.periodo === periodo);
  });

  const { desde, hasta } = getRangoPeriodo(periodo);
  const enRango = f => { const d = parseFechaCO(f); return d >= desde && d <= hasta; };
  const ventas = DB.ventas.filter(v => enRango(v.fecha));
  const gastos = DB.gastos.filter(g => enRango(g.fecha));
  const costos = DB.costos.filter(c => enRango(c.fecha));
  const r = resumenMetodos(ventas, gastos, costos);

  const labels = {
    dia:'hoy', semana:'esta semana', mes:'este mes', año:'este año',
    'dia-esp': 'el ' + fechaCO(desde),
    'semana-esp': 'la semana del ' + fechaCO(desde) + ' al ' + fechaCO(hasta),
    'mes-esp': 'de ' + MESES_LARGO[desde.getMonth()] + ' ' + desde.getFullYear()
  };

  const rango = document.getElementById('reporte-rango');
  if (rango) {
    const mismo = fechaCO(desde) === fechaCO(hasta);
    const conFechas = periodo !== 'dia-esp' && periodo !== 'semana-esp';
    rango.textContent = 'Mostrando ' + labels[periodo] + (conFechas ? ' · ' + fechaCO(desde) + (mismo ? '' : ' – ' + fechaCO(hasta)) : '');
  }

  const promedio = ventas.length ? r.vendido / ventas.length : 0;

  // Métricas principales
  document.getElementById('reporte-metrics').innerHTML =
    kpiHTML('rosa', 'ti-trending-up', 'Total vendido', fmt(r.vendido)) +
    kpiHTML('dorado', 'ti-coin', 'Ganancia', fmt(r.ganancia)) +
    kpiHTML('danger', 'ti-receipt-2', 'Gastos', fmt(r.gasto)) +
    kpiHTML('danger', 'ti-box-seam', 'Costos', fmt(r.costo)) +
    kpiHTML(r.neto < 0 ? 'danger' : 'neto', 'ti-wallet', 'Ganancia neta', fmt(r.neto), 'Ganancia − gastos − costos') +
    kpiHTML('teal', 'ti-shopping-bag', 'Transacciones', String(ventas.length), ventas.length ? 'Promedio ' + fmt(promedio) : '');

  renderGraficaReporte(periodo, ventas, desde, labels[periodo]);

  // Dona efectivo vs transferencia
  const dona = document.getElementById('reporte-dona');
  if (dona) {
    if (r.vendido > 0) {
      const C = 2 * Math.PI * 64, pEf = r.vEf / r.vendido;
      dona.innerHTML = `
        <div class="dona-wrap"><svg width="170" height="170" viewBox="0 0 170 170" role="img" aria-label="${Math.round(pEf*100)} % efectivo, ${100-Math.round(pEf*100)} % transferencia">
          <circle cx="85" cy="85" r="64" fill="none" stroke="var(--dorado)" stroke-width="22"/>
          <circle cx="85" cy="85" r="64" fill="none" stroke="var(--rosa)" stroke-width="22" stroke-dasharray="${(C*pEf).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 85 85)"/>
          <text x="85" y="87" text-anchor="middle" class="dona-pct">${Math.round(pEf*100)} %</text>
          <text x="85" y="107" text-anchor="middle" class="dona-sub">en efectivo</text>
        </svg></div>
        <div class="dona-leyenda">
          <div><i class="rg-dot" style="background:var(--rosa)"></i><span>Efectivo</span><strong>${fmt(r.vEf)}</strong></div>
          <div><i class="rg-dot" style="background:var(--dorado)"></i><span>Transferencia</span><strong>${fmt(r.vTr)}</strong></div>
        </div>`;
    } else {
      dona.innerHTML = `<div class="estado-vacio" style="padding:1.5rem"><i class="ti ti-chart-donut"></i><p>Sin ventas en este periodo.</p></div>`;
    }
  }

  // Desglose por método de pago — ventas
  document.getElementById('reporte-pago').innerHTML = `
    <div class="reporte-pago-card">
      <span class="rp-icon">💵</span>
      <div class="rp-label">Ventas en Efectivo</div>
      <div class="rp-value">${fmt(r.vEf)}</div>
      <div class="rp-sub">Ganancia: ${fmt(r.gaEf)}</div>
    </div>
    <div class="reporte-pago-card">
      <span class="rp-icon">🏦</span>
      <div class="rp-label">Ventas por Transferencia</div>
      <div class="rp-value">${fmt(r.vTr)}</div>
      <div class="rp-sub">Ganancia: ${fmt(r.gaTr)}</div>
    </div>
    <div class="reporte-pago-card destacada">
      <span class="rp-icon">📊</span>
      <div class="rp-label">Total combinado</div>
      <div class="rp-value">${fmt(r.vendido)}</div>
      <div class="rp-sub">Ganancia total: ${fmt(r.ganancia)}</div>
    </div>`;

  // Ganancia neta del periodo, separada por efectivo / transferencia
  const neg = n => n < 0 ? ' neg' : '';
  document.getElementById('reporte-neto').innerHTML = `
    <div class="rep-ecuacion">
      <div class="eq-caja"><span>Ganancia de ventas</span><strong class="dorado">${fmt(r.ganancia)}</strong></div>
      <span class="eq-signo">−</span>
      <div class="eq-caja"><span>Gastos</span><strong class="rojo">${fmt(r.gasto)}</strong></div>
      <span class="eq-signo">−</span>
      <div class="eq-caja"><span>Costos</span><strong class="rojo">${fmt(r.costo)}</strong></div>
      <span class="eq-signo">=</span>
      <div class="eq-caja eq-total"><span>Ganancia neta</span><strong>${fmt(r.neto)}</strong></div>
    </div>
    <div class="rep-neto-grid">
      <div class="reporte-pago-card">
        <span class="rp-icon">💵</span>
        <div class="rp-label">Ganancia neta en Efectivo</div>
        <div class="rp-value${neg(r.netoEf)}">${fmt(r.netoEf)}</div>
        <div class="rp-sub">Ganancia ${fmt(r.gaEf)} − Gastos ${fmt(r.gsEf)} − Costos ${fmt(r.csEf)}</div>
      </div>
      <div class="reporte-pago-card">
        <span class="rp-icon">🏦</span>
        <div class="rp-label">Ganancia neta en Transferencia</div>
        <div class="rp-value${neg(r.netoTr)}">${fmt(r.netoTr)}</div>
        <div class="rp-sub">Ganancia ${fmt(r.gaTr)} − Gastos ${fmt(r.gsTr)} − Costos ${fmt(r.csTr)}</div>
      </div>
      <div class="reporte-pago-card destacada">
        <span class="rp-icon">📊</span>
        <div class="rp-label">Ganancia neta total</div>
        <div class="rp-value${neg(r.neto)}">${fmt(r.neto)}</div>
        <div class="rp-sub">Efectivo + Transferencia</div>
      </div>
    </div>`;

  // Costos del periodo por categoría
  const contCostos = document.getElementById('reporte-costos');
  if (contCostos) {
    const porCat = {};
    costos.forEach(c => { porCat[c.categoria] = (porCat[c.categoria] || 0) + c.monto; });
    const cats = Object.keys(porCat).sort((a, b) => porCat[b] - porCat[a]);
    contCostos.innerHTML = cats.length
      ? cats.map(k => `<div class="reporte-pago-card"><div class="rp-label">${esc(k)}</div><div class="rp-value">${fmt(porCat[k])}</div></div>`).join('')
        + `<div class="reporte-pago-card destacada"><div class="rp-label">Total costos</div><div class="rp-value">${fmt(r.costo)}</div></div>`
      : `<p style="font-size:13px;color:var(--texto2)">Sin costos registrados en este periodo.</p>`;
  }

  // Resumen neto: el mes actual, o el mes que se esté consultando
  renderResumenNetoMes(periodo === 'mes-esp' ? desde : null);
}

// ---------- Gráfica de reportes ----------
function horaDeVenta(v) {
  const m = String(v.hora || '').match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*([apAP])?/);
  if (!m) return null;
  let h = parseInt(m[1]);
  if (m[3]) {
    const pm = m[3].toLowerCase() === 'p';
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
  }
  return (h >= 0 && h <= 23) ? h : null;
}

function reporteSerie(periodo, ventas, desde) {
  let cats = [], titulo = '';
  if (periodo === 'dia' || periodo === 'dia-esp') {
    titulo = 'Ventas por hora';
    let min = 6, max = 21;
    const horas = ventas.map(horaDeVenta);
    horas.forEach(h => { if (h != null) { min = Math.min(min, h); max = Math.max(max, h); } });
    for (let h = min; h <= max; h++) cats.push({ label: h + 'h', tip: `${h}:00 a ${h}:59`, vendido: 0, ganancia: 0 });
    ventas.forEach((v, i) => {
      const h = horas[i]; if (h == null) return;
      cats[h - min].vendido += v.total; cats[h - min].ganancia += v.ganancia;
    });
  } else if (periodo === 'semana' || periodo === 'semana-esp') {
    titulo = 'Ventas por día de la semana';
    for (let i = 0; i < 7; i++) {
      const d = new Date(desde); d.setDate(desde.getDate() + i);
      cats.push({ label: DIAS_CORTO[i], tip: DIAS_CORTO[i] + ' ' + fechaCO(d), vendido: 0, ganancia: 0 });
    }
    ventas.forEach(v => {
      const i = Math.round((parseFechaCO(v.fecha) - desde) / 86400000);
      if (cats[i]) { cats[i].vendido += v.total; cats[i].ganancia += v.ganancia; }
    });
  } else if (periodo === 'mes' || periodo === 'mes-esp') {
    titulo = 'Ventas por día del mes';
    const n = new Date(desde.getFullYear(), desde.getMonth() + 1, 0).getDate();
    for (let i = 1; i <= n; i++) cats.push({ label: String(i), tip: fechaCO(new Date(desde.getFullYear(), desde.getMonth(), i)), vendido: 0, ganancia: 0 });
    ventas.forEach(v => {
      const i = parseFechaCO(v.fecha).getDate() - 1;
      if (cats[i]) { cats[i].vendido += v.total; cats[i].ganancia += v.ganancia; }
    });
  } else {
    titulo = 'Ventas por mes';
    for (let i = 0; i < 12; i++) cats.push({ label: MESES_CORTO[i], tip: MESES_LARGO[i] + ' ' + desde.getFullYear(), vendido: 0, ganancia: 0 });
    ventas.forEach(v => {
      const i = parseFechaCO(v.fecha).getMonth();
      if (cats[i]) { cats[i].vendido += v.total; cats[i].ganancia += v.ganancia; }
    });
  }
  return { titulo, cats };
}

function fmtCorto(n) {
  if (n >= 1000000) return '$' + (n / 1000000).toFixed(1).replace('.0', '').replace('.', ',') + ' M';
  if (n >= 1000) return '$' + Math.round(n / 1000) + ' mil';
  return '$' + Math.round(n);
}

function pasoBonito(x) {
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const r = x / p;
  return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * p;
}

function renderGraficaReporte(periodo, ventas, desde, etiqueta) {
  const cont = document.getElementById('reporte-grafica');
  const tit = document.getElementById('reporte-grafica-titulo');
  if (!cont) return;
  const { titulo, cats } = reporteSerie(periodo, ventas, desde);
  tit.textContent = `${titulo} — ${etiqueta}`;

  if (!ventas.length) {
    cont.innerHTML = `<div class="estado-vacio" style="padding:1.5rem"><i class="ti ti-chart-bar"></i><p>Sin ventas en este periodo.</p></div>`;
    return;
  }

  const n = cats.length;
  const W = Math.max(cont.clientWidth || 640, n * 30 + 70, 560), H = 300, ml = 62, mr = 12, mt = 18, mb = 34;
  const iw = W - ml - mr, ih = H - mt - mb;
  const maxVal = Math.max(1, ...cats.map(x => Math.max(x.vendido, x.ganancia, 0)));
  const paso = pasoBonito(maxVal / 4);
  const tope = Math.ceil(maxVal / paso) * paso;
  const y = v => mt + ih - (Math.max(0, v) / tope) * ih;
  const gw = iw / n, bw = Math.min(18, gw * 0.38);

  let svg = '';
  for (let t = 0; t <= tope + 0.001; t += paso) {
    svg += `<line x1="${ml}" x2="${W - mr}" y1="${y(t)}" y2="${y(t)}" class="rg-grid"/>`;
    svg += `<text x="${ml - 8}" y="${y(t) + 4}" text-anchor="end">${fmtCorto(t)}</text>`;
  }
  cats.forEach((x, i) => {
    const cx = ml + gw * i + gw / 2;
    const hv = (Math.max(0, x.vendido) / tope) * ih, hg = (Math.max(0, x.ganancia) / tope) * ih;
    svg += `<g><title>${x.tip}\nVendido: ${fmt(x.vendido)}\nGanancia: ${fmt(x.ganancia)}</title>
      <rect x="${cx - bw - 1}" y="${mt + ih - hv}" width="${bw}" height="${hv}" rx="3" class="rg-vendido"/>
      <rect x="${cx + 1}" y="${mt + ih - hg}" width="${bw}" height="${hg}" rx="3" class="rg-ganancia"/>
      <rect x="${cx - gw / 2}" y="${mt}" width="${gw}" height="${ih}" fill="transparent"/></g>`;
    if (n <= 12 && x.vendido > 0) svg += `<text x="${cx - bw / 2 - 1}" y="${mt + ih - hv - 5}" text-anchor="middle" class="rg-valor">${fmtCorto(x.vendido)}</text>`;
    svg += `<text x="${cx}" y="${H - 12}" text-anchor="middle">${x.label}</text>`;
  });

  cont.innerHTML = `
    <div class="rg-leyenda"><span><i class="rg-dot rg-vendido"></i> Vendido</span><span><i class="rg-dot rg-ganancia"></i> Ganancia</span></div>
    <div class="tabla-wrap"><svg class="rep-graf" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${titulo}">${svg}</svg></div>`;
}

// Resumen neto del mes actual: ganancia de ventas menos gastos, y ventas menos pagos a proveedores.
// Siempre calculado para el mes en curso (se "reinicia" solo porque nunca acumula meses anteriores).
function renderResumenNetoMes(ref) {
  const hoy = ref || new Date();
  const tit = document.getElementById('resumen-neto-titulo');
  if (tit) tit.textContent = ref ? `Resumen neto de ${MESES_LARGO[hoy.getMonth()]} ${hoy.getFullYear()}` : 'Resumen neto del mes';
  const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const finMes = new Date(hoy.getFullYear(), hoy.getMonth()+1, 0, 23,59,59,999);

  const ventasMes = DB.ventas.filter(v => { const d = parseFechaCO(v.fecha); return d>=inicioMes && d<=finMes; });
  const gastosMes = DB.gastos.filter(g => { const d = parseFechaCO(g.fecha); return d>=inicioMes && d<=finMes; });
  const costosMes = DB.costos.filter(c => { const d = parseFechaCO(c.fecha); return d>=inicioMes && d<=finMes; });
  const r = resumenMetodos(ventasMes, gastosMes, costosMes);

  const pagosProveedoresMes = DB.proveedores.flatMap(p => p.abonos||[])
    .filter(a => { const d = parseFechaCO(a.fecha); return d>=inicioMes && d<=finMes; })
    .reduce((s,a)=>s+a.monto,0);
  const ventasNetasMes = r.vendido - pagosProveedoresMes;

  document.getElementById('resumen-neto-metrics').innerHTML = `
    <div class="rep-kpis">
      ${kpiHTML('dorado', 'ti-coin', 'Ganancia del mes', fmt(r.ganancia))}
      ${kpiHTML('danger', 'ti-receipt-2', 'Gastos del mes', fmt(r.gasto))}
      ${kpiHTML('danger', 'ti-box-seam', 'Costos del mes', fmt(r.costo))}
      ${kpiHTML(r.neto < 0 ? 'danger' : 'neto', 'ti-wallet', 'Ganancia neta del mes', fmt(r.neto))}
      ${kpiHTML('rosa', 'ti-trending-up', 'Ventas del mes', fmt(r.vendido))}
      ${kpiHTML('danger', 'ti-building-warehouse', 'Pagos a proveedores', fmt(pagosProveedoresMes))}
      ${kpiHTML('teal', 'ti-scale', 'Ventas netas del mes', fmt(ventasNetasMes))}
    </div>`;

  document.getElementById('resumen-neto-pago').innerHTML = `
    <div class="reporte-pago-card">
      <span class="rp-icon">💵</span>
      <div class="rp-label">Neto en Efectivo</div>
      <div class="rp-value">${fmt(r.netoEf)}</div>
      <div class="rp-sub">Ganancia ${fmt(r.gaEf)} − Gastos ${fmt(r.gsEf)} − Costos ${fmt(r.csEf)}</div>
    </div>
    <div class="reporte-pago-card">
      <span class="rp-icon">🏦</span>
      <div class="rp-label">Neto en Transferencia</div>
      <div class="rp-value">${fmt(r.netoTr)}</div>
      <div class="rp-sub">Ganancia ${fmt(r.gaTr)} − Gastos ${fmt(r.gsTr)} − Costos ${fmt(r.csTr)}</div>
    </div>`;
}

// =============================================
// CONFIGURACIÓN
// =============================================
function renderConfig() {
  document.getElementById('conf-stock-min').value = DB.config.stockMin;
  const lista = document.getElementById('usuarios-list');
  lista.innerHTML = DB.usuarios.map((u,i)=>`
    <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 12px;background:var(--blush-claro);border-radius:8px;margin-bottom:6px;border:0.5px solid var(--borde)">
      <div><span style="font-weight:500">${esc(u.user)}</span>
      <span class="badge ${u.rol==='admin'?'rosa':'ok'}" style="margin-left:8px">${u.rol}</span></div>
      ${DB.usuarios.length>1?`<button class="btn-peligro btn-eliminar-usuario" data-idx="${i}" style="padding:5px 9px"><i class="ti ti-trash"></i></button>`:''}
    </div>`).join('');
  lista.querySelectorAll('.btn-eliminar-usuario').forEach(b=>b.addEventListener('click',()=>eliminarUsuario(parseInt(b.dataset.idx))));
}

async function agregarUsuario() {
  const user=document.getElementById('nu-user').value.trim();
  const pass=document.getElementById('nu-pass').value;
  const rol=document.getElementById('nu-rol').value;
  if (!user||!pass) { alert('Completa usuario y contraseña'); return; }
  if (DB.usuarios.find(u=>u.user===user)) { alert('Ese usuario ya existe'); return; }
  DB.usuarios.push({user,pass,rol}); guardarLocal();
  await sheetsEscribir('append','Usuarios',[user,pass,rol]);
  document.getElementById('nu-user').value=''; document.getElementById('nu-pass').value='';
  renderConfig(); mostrarToast('Usuario agregado ✓');
}

function eliminarUsuario(idx) {
  if (!confirm('¿Eliminar este usuario?')) return;
  DB.usuarios.splice(idx,1); guardarLocal(); renderConfig(); mostrarToast('Usuario eliminado');
}

async function guardarConfig() {
  DB.config.stockMin=parseInt(document.getElementById('conf-stock-min').value)||5;
  guardarLocal();
  await guardarConfigSheet();
  mostrarToast('Configuración guardada ✓');
}

// =============================================
// LIQUIDACIÓN DE VENDEDORES
// =============================================
// Cada vendedor es un cliente que tiene su lista fija de precios
// (precio de lista = lo que le cobra la heladería, precio público = lo que
// él vende). Se anota lo que se lleva (cargue / recargue) y lo que regresa
// (devolución); la página calcula lo vendido, lo que debe pagar y su ganancia.
// Cargue/recargue descuentan del inventario y la devolución lo regresa.
let liqActual = null;   // liquidación en edición (copia de trabajo)

function liqNum(v) { return Math.max(0, parseFloat(v) || 0); }

function liqCalcItem(it) {
  const venta = Math.max(0, liqNum(it.cargue) + liqNum(it.recargue) - liqNum(it.devolucion));
  const lista = liqNum(it.precioLista), pub = liqNum(it.precioPublico);
  return { venta, valor: venta * lista, ventaCI: venta * pub, ganancia: venta * (pub - lista) };
}

function liqTotales(l) {
  const t = { unidades: 0, total: 0, ventaCI: 0, ganancia: 0 };
  (l.items || []).forEach(it => {
    const c = liqCalcItem(it);
    t.unidades += c.venta; t.total += c.valor; t.ventaCI += c.ventaCI; t.ganancia += c.ganancia;
  });
  t.pagado = (l.pagos || []).reduce((a, x) => a + (Number(x.monto) || 0), 0);
  t.saldo = Math.max(0, t.total - t.pagado);
  return t;
}

function liqClonar(l) { return JSON.parse(JSON.stringify(l)); }

function liqItemsDesdeVendedor(c) {
  return (c.precios || []).map(x => {
    const p = DB.productos.find(y => y.id === x.productoId);
    const d = p ? preciosPorDefecto(p) : { precio: 0, publico: 0 };
    return {
      productoId: x.productoId, ref: x.ref || '', nombre: x.nombre || '',
      cargue: 0, recargue: 0, devolucion: 0,
      precioLista: Number(x.precio) || d.precio, precioPublico: Number(x.publico) || d.publico, aplicado: 0
    };
  });
}

function liqBorradorNuevo(c) {
  const ahora = new Date();
  return { id: uid(), clienteId: c.id, nombre: c.nombre, fecha: fechaCO(ahora), hora: horaCO(ahora),
           items: liqItemsDesdeVendedor(c), pagos: [], nota: '' };
}

function parsearLiquidacion(f) {
  const items = parsearJSON(f[5]);
  const pagos = parsearJSON(f[10]);
  const hora = String(f[4] || '');
  return {
    id: String(f[0]), clienteId: String(f[1] || ''), nombre: String(f[2] || ''),
    fecha: isoAFechaCO(f[3]), hora: /^\d{4}-\d{2}-\d{2}T/.test(hora) ? '' : hora,
    items: Array.isArray(items) ? items : [], pagos: Array.isArray(pagos) ? pagos : [],
    nota: String(f[11] || '')
  };
}

function liqFila(l) {
  const t = liqTotales(l);
  return [l.id, l.clienteId, l.nombre, l.fecha, l.hora, JSON.stringify(l.items),
          t.unidades, t.total, t.ventaCI, t.ganancia, JSON.stringify(l.pagos || []), l.nota || ''];
}

function liqVendedorActual() {
  return liqActual ? DB.clientes.find(c => c.id === liqActual.clienteId) : null;
}

// ---------- vendedor ----------
function liqMostrarVendedor() {
  const box = document.getElementById('liq-cliente-seleccionado');
  const prod = document.getElementById('liq-producto-box');
  if (!liqActual) { box.classList.add('hidden'); prod.classList.add('hidden'); return; }
  const c = liqVendedorActual();
  document.getElementById('liq-cliente-nombre').textContent = liqActual.nombre;
  document.getElementById('liq-cliente-detalle').textContent = c
    ? `${c.tipoDoc || 'CC'} ${c.cedula}${c.telefono ? ' · Tel: ' + c.telefono : ''} · ${(c.precios || []).length} producto(s) con precio`
    : 'Cliente ya no existe en la lista';
  box.classList.remove('hidden');
  prod.classList.remove('hidden');
}

function seleccionarVendedorLiq(c) {
  const hoy = fechaCO();
  const delDia = DB.liquidaciones.filter(l => l.clienteId === c.id && l.fecha === hoy);
  liqActual = delDia.length ? liqClonar(delDia[delDia.length - 1]) : liqBorradorNuevo(c);
  liqMostrarVendedor();
  renderLiqEditor();
}

function quitarVendedorLiq() {
  liqActual = null;
  liqMostrarVendedor();
  renderLiqEditor();
}

function nuevaLiquidacion() {
  const c = liqVendedorActual();
  if (!c) { alert('Primero elige el vendedor.'); return; }
  if (!confirm('¿Empezar una liquidación nueva para ' + c.nombre + '? Lo que no hayas guardado se pierde.')) return;
  liqActual = liqBorradorNuevo(c);
  liqMostrarVendedor();
  renderLiqEditor();
}

function abrirLiquidacion(id) {
  const l = DB.liquidaciones.find(x => x.id === id);
  if (!l) return;
  liqActual = liqClonar(l);
  liqMostrarVendedor();
  renderLiqEditor();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------- productos ----------
function agregarProductoLiq(p) {
  if (!liqActual) { alert('Primero elige el vendedor.'); return; }
  let i = liqActual.items.findIndex(x => x.productoId === p.id);
  if (i < 0) {
    const c = liqVendedorActual();
    const esp = c && (c.precios || []).find(x => x.productoId === p.id);
    liqActual.items.push({
      productoId: p.id, ref: p.ref, nombre: p.nombre, cargue: 0, recargue: 0, devolucion: 0,
      precioLista: (esp && Number(esp.precio)) ? Number(esp.precio) : preciosPorDefecto(p).precio,
      precioPublico: (esp && Number(esp.publico)) ? Number(esp.publico) : preciosPorDefecto(p).publico,
      aplicado: 0
    });
    i = liqActual.items.length - 1;
  }
  renderLiqEditor();
  setTimeout(() => {
    const inp = document.querySelector(`#liq-editor tr[data-i="${i}"] .liq-in`);
    if (inp) { inp.focus(); inp.select(); }
  }, 50);
}

// ---------- edición ----------
function liqRefrescarFila(i) {
  const it = liqActual.items[i];
  const tr = document.querySelector(`#liq-editor tr[data-i="${i}"]`);
  if (!tr) return;
  const c = liqCalcItem(it);
  tr.querySelector('.c-venta').textContent = c.venta;
  tr.querySelector('.c-valor').textContent = fmt(c.valor);
  tr.querySelector('.c-ventaci').textContent = fmt(c.ventaCI);
  tr.querySelector('.c-ganancia').textContent = fmt(c.ganancia);
}

function liqRefrescarTotales() {
  if (!liqActual) return;
  const t = liqTotales(liqActual);
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('liq-m-unidades', t.unidades);
  set('liq-m-total', fmt(t.total));
  set('liq-m-ventaci', fmt(t.ventaCI));
  set('liq-m-ganancia', fmt(t.ganancia));
  set('liq-m-pagado', fmt(t.pagado));
  set('liq-m-saldo', fmt(t.saldo));
  set('liq-f-venta', t.unidades);
  set('liq-f-valor', fmt(t.total));
  set('liq-f-ventaci', fmt(t.ventaCI));
  set('liq-f-ganancia', fmt(t.ganancia));
}

function renderLiqEditor() {
  const cont = document.getElementById('liq-editor');
  if (!cont) return;
  if (!liqActual) {
    cont.innerHTML = `<div class="estado-vacio"><i class="ti ti-truck-delivery"></i><p>Elige un vendedor para armar su liquidación.</p></div>`;
    return;
  }
  const l = liqActual;
  const guardada = !!DB.liquidaciones.find(x => x.id === l.id);
  const t = liqTotales(l);

  const inp = (i, campo, valor, ancho) =>
    `<input type="number" min="0" class="liq-in" data-i="${i}" data-f="${campo}" value="${valor ? valor : ''}" placeholder="0" style="width:${ancho || 56}px">`;

  const filas = l.items.map((it, i) => {
    const c = liqCalcItem(it);
    return `<tr data-i="${i}">
      <td style="min-width:150px">${esc(it.nombre)}<div style="font-size:11px;color:var(--texto2)">${esc(it.ref || '')}</div></td>
      <td>${inp(i, 'cargue', it.cargue)}</td>
      <td>${inp(i, 'recargue', it.recargue)}</td>
      <td>${inp(i, 'devolucion', it.devolucion)}</td>
      <td class="c-venta" style="font-weight:600;text-align:center">${c.venta}</td>
      <td>${inp(i, 'precioLista', it.precioLista, 74)}</td>
      <td class="c-valor">${fmt(c.valor)}</td>
      <td>${inp(i, 'precioPublico', it.precioPublico, 74)}</td>
      <td class="c-ventaci">${fmt(c.ventaCI)}</td>
      <td class="c-ganancia" style="color:var(--rosa-oscuro);font-weight:500">${fmt(c.ganancia)}</td>
      <td><button type="button" class="btn-peligro btn-quitar-liq-item" data-i="${i}" style="padding:5px 9px"><i class="ti ti-x"></i></button></td>
    </tr>`;
  }).join('');

  const pagos = (l.pagos || []).map((p, i) => `
    <tr><td>${i + 1}</td><td>${esc(p.fecha || '')} ${esc(p.hora || '')}</td>
    <td>${liqTextoMetodo(p, true)}</td>
    <td style="text-align:right">${fmt(p.monto)}</td></tr>`).join('');

  cont.innerHTML = `
    <div id="liq-metrics">
      <div class="metric"><div class="mlabel">Total unidades</div><div class="mvalue" id="liq-m-unidades">${t.unidades}</div></div>
      <div class="metric rosa"><div class="mlabel">Total a pagar (venta)</div><div class="mvalue" id="liq-m-total">${fmt(t.total)}</div></div>
      <div class="metric"><div class="mlabel">Venta al público</div><div class="mvalue" id="liq-m-ventaci">${fmt(t.ventaCI)}</div></div>
      <div class="metric"><div class="mlabel">Ganancia vendedor</div><div class="mvalue" id="liq-m-ganancia">${fmt(t.ganancia)}</div></div>
      <div class="metric"><div class="mlabel">Pagado</div><div class="mvalue" id="liq-m-pagado">${fmt(t.pagado)}</div></div>
      <div class="metric alerta"><div class="mlabel">Saldo</div><div class="mvalue" id="liq-m-saldo">${fmt(t.saldo)}</div></div>
    </div>
    <p style="font-size:12px;color:var(--texto2);margin-bottom:8px">${esc(l.fecha)} ${esc(l.hora || '')} · ${guardada ? 'Guardada' : '<strong>Sin guardar</strong>'}. Venta = Cargue + Recargue − Devolución.</p>
    ${l.items.length === 0 ? '<p style="font-size:13px;color:var(--texto2);margin:8px 0">Este vendedor no tiene lista de precios. Busca un producto arriba para agregarlo.</p>' : `
    <div class="tabla-wrap"><table class="liq-tabla">
      <thead><tr><th>Producto</th><th>Cargue</th><th>Recargue</th><th>Devolución</th><th>Venta</th><th>Precio lista</th><th>Valor total</th><th>Precio público</th><th>Venta CI</th><th>Ganancia CI</th><th></th></tr></thead>
      <tbody>${filas}</tbody>
      <tfoot><tr style="font-weight:600">
        <td colspan="4">TOTAL</td><td id="liq-f-venta" style="text-align:center">${t.unidades}</td><td></td>
        <td id="liq-f-valor">${fmt(t.total)}</td><td></td><td id="liq-f-ventaci">${fmt(t.ventaCI)}</td><td id="liq-f-ganancia">${fmt(t.ganancia)}</td><td></td>
      </tr></tfoot>
    </table></div>`}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin:1rem 0">
      <button class="btn-primary" id="btn-liq-guardar"><i class="ti ti-device-floppy"></i> Guardar liquidación</button>
      <button class="btn-primary" id="btn-liq-pago"><i class="ti ti-cash"></i> Registrar pago</button>
      <button class="btn-secundario" id="btn-liq-imprimir"><i class="ti ti-printer"></i> Imprimir</button>
      <button class="btn-secundario" id="btn-liq-precios"><i class="ti ti-tags"></i> Guardar precios al vendedor</button>
    </div>
    ${pagos ? `<p style="font-size:13px;font-weight:500;margin-bottom:6px">Pagos registrados</p>
      <div class="tabla-wrap"><table><thead><tr><th>#</th><th>Fecha</th><th>Método</th><th>Monto</th></tr></thead><tbody>${pagos}</tbody></table></div>` : ''}
  `;

  const entradas = Array.from(cont.querySelectorAll('.liq-in'));
  entradas.forEach((el, idx) => {
    el.addEventListener('input', () => {
      const i = parseInt(el.dataset.i);
      liqActual.items[i][el.dataset.f] = parseFloat(el.value) || 0;
      liqRefrescarFila(i);
      liqRefrescarTotales();
    });
    el.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const sig = entradas[idx + 1];
      if (sig) { sig.focus(); sig.select(); }
    });
  });
  cont.querySelectorAll('.btn-quitar-liq-item').forEach(b => b.addEventListener('click', () => {
    liqActual.items.splice(parseInt(b.dataset.i), 1);
    renderLiqEditor();
  }));
  document.getElementById('btn-liq-guardar').addEventListener('click', () => guardarLiquidacion());
  document.getElementById('btn-liq-pago').addEventListener('click', abrirModalPagoLiq);
  document.getElementById('btn-liq-imprimir').addEventListener('click', () => imprimirLiquidacion(liqActual));
  document.getElementById('btn-liq-precios').addEventListener('click', guardarPreciosVendedorDesdeLiq);
}

// ---------- guardar ----------
async function guardarLiquidacion() {
  if (!liqActual) return false;
  const l = liqActual;
  if (!l.items.some(it => liqNum(it.cargue) + liqNum(it.recargue) > 0)) {
    alert('Anota el cargue de al menos un producto antes de guardar.');
    return false;
  }
  const btn = document.getElementById('btn-liq-guardar');
  if (btn && btn.disabled) return false;
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }

  try {
    const prev = DB.liquidaciones.find(x => x.id === l.id);
    const esNuevo = !prev;
    const items = l.items.map(it => ({
      ...it,
      cargue: liqNum(it.cargue), recargue: liqNum(it.recargue), devolucion: liqNum(it.devolucion),
      precioLista: liqNum(it.precioLista), precioPublico: liqNum(it.precioPublico),
      aplicado: liqCalcItem(it).venta
    }));
    const nueva = { ...liqClonar(l), items };

    const ok = await sheetsEscribir(esNuevo ? 'append' : 'update', 'Liquidaciones', liqFila(nueva), esNuevo ? undefined : nueva.id);
    if (!ok) throw new Error('Google Sheets no confirmó el guardado de la liquidación.');

    // Inventario: se descuenta lo vendido (cargue + recargue − devolución)
    // y solo se mueve la diferencia contra lo que ya se había aplicado.
    const previo = {}, actual = {};
    (prev ? prev.items : []).forEach(it => { if (it.productoId) previo[it.productoId] = (previo[it.productoId] || 0) + (Number(it.aplicado) || 0); });
    items.forEach(it => { if (it.productoId) actual[it.productoId] = (actual[it.productoId] || 0) + it.aplicado; });
    for (const pid of new Set([...Object.keys(previo), ...Object.keys(actual)])) {
      const delta = (actual[pid] || 0) - (previo[pid] || 0);
      if (!delta) continue;
      const p = DB.productos.find(x => x.id === pid);
      if (p) {
        p.stock = p.stock - delta;
        await sheetsEscribir('update', 'Productos', [p.id, p.ref, p.nombre, p.pcompra, p.pventa1, p.pventa2, p.stock], p.id);
      }
    }

    if (esNuevo) DB.liquidaciones.push(nueva);
    else DB.liquidaciones[DB.liquidaciones.findIndex(x => x.id === nueva.id)] = nueva;
    liqActual = liqClonar(nueva);
    guardarLocal();
    renderLiqEditor();
    renderLiqHistorial();
    mostrarToast('Liquidación guardada ✓');
    return true;
  } catch (e) {
    console.error('Error guardando liquidación:', e);
    alert('NO SE PUDO GUARDAR LA LIQUIDACIÓN.\n\n' + (e && e.message ? e.message : String(e)));
    return false;
  } finally {
    const b = document.getElementById('btn-liq-guardar');
    if (b) { b.disabled = false; b.innerHTML = '<i class="ti ti-device-floppy"></i> Guardar liquidación'; }
  }
}

async function guardarPreciosVendedorDesdeLiq() {
  const c = liqVendedorActual();
  if (!c) { alert('El vendedor ya no existe en Clientes.'); return; }
  if (!confirm('¿Dejar estos precios (lista y público) como los precios fijos de ' + c.nombre + '?')) return;
  liqActual.items.forEach(it => {
    const x = (c.precios || []).find(e => e.productoId === it.productoId);
    if (x) { x.precio = liqNum(it.precioLista); x.publico = liqNum(it.precioPublico); }
    else {
      c.precios = c.precios || [];
      c.precios.push({ productoId: it.productoId, ref: it.ref || '', nombre: it.nombre || '', precio: liqNum(it.precioLista), publico: liqNum(it.precioPublico) });
    }
  });
  const ok = await sheetsEscribir('update', 'Clientes', [c.id, c.nombre, c.cedula, c.telefono, c.direccion, c.correo, c.tipoDoc, JSON.stringify(c.precios)], c.id);
  guardarLocal();
  if (ok) { mostrarToast('Precios del vendedor guardados ✓'); liqMostrarVendedor(); }
  else alert('No se pudieron guardar los precios del vendedor en Google Sheets.');
}

// ---------- pagos ----------
function liqTextoMetodo(p, conIconos) {
  if (p.metodoPago === 'mixto') {
    return conIconos
      ? `🔀 Mixto <span style="font-size:11px;color:var(--texto2)">(💵 ${fmt(p.efectivo || 0)} + 🏦 ${fmt(p.transferencia || 0)})</span>`
      : `Mixto (Efectivo ${fmt(p.efectivo || 0)} + Transferencia ${fmt(p.transferencia || 0)})`;
  }
  if (p.metodoPago === 'transferencia') return conIconos ? '🏦 Transferencia' : 'Transferencia';
  return conIconos ? '💵 Efectivo' : 'Efectivo';
}

function liqActualizarMixto() {
  const monto = parseFloat(document.getElementById('liq-pago-monto').value) || 0;
  const ef = parseFloat(document.getElementById('liq-pago-mixto-efectivo').value) || 0;
  const tr = parseFloat(document.getElementById('liq-pago-mixto-transferencia').value) || 0;
  const dif = monto - ef - tr;
  const el = document.getElementById('liq-pago-mixto-restante');
  el.textContent = dif === 0 ? 'Cuadrado ✓' : (dif > 0 ? `Falta: ${fmt(dif)}` : `Sobra: ${fmt(-dif)}`);
  el.style.color = dif === 0 ? 'var(--rosa-oscuro)' : '#A32D2D';
}

async function abrirModalPagoLiq() {
  if (!liqActual) return;
  const ok = await guardarLiquidacion();
  if (!ok) return;
  const t = liqTotales(liqActual);
  if (t.saldo <= 0) { alert('Esta liquidación ya está pagada por completo.'); return; }
  document.getElementById('liq-pago-nombre').textContent = liqActual.nombre;
  document.getElementById('liq-pago-saldo').textContent = `Saldo pendiente: ${fmt(t.saldo)}`;
  document.getElementById('liq-pago-monto').value = t.saldo;
  document.querySelector('input[name="liq-pago-metodo"][value="efectivo"]').checked = true;
  document.getElementById('liq-pago-mixto-box').classList.add('hidden');
  document.getElementById('liq-pago-mixto-efectivo').value = 0;
  document.getElementById('liq-pago-mixto-transferencia').value = 0;
  abrirModal('modal-liq-pago');
  setTimeout(() => { const m = document.getElementById('liq-pago-monto'); m.focus(); m.select(); }, 100);
}

async function guardarPagoLiq() {
  const l = liqActual ? DB.liquidaciones.find(x => x.id === liqActual.id) : null;
  if (!l) return;
  const t = liqTotales(l);
  const monto = parseFloat(document.getElementById('liq-pago-monto').value) || 0;
  if (monto <= 0) { alert('Ingresa un monto válido'); return; }
  if (monto > t.saldo) { alert(`El pago no puede ser mayor al saldo pendiente (${fmt(t.saldo)})`); return; }
  const metodoPago = document.querySelector('input[name="liq-pago-metodo"]:checked').value;

  // Partes del pago: una sola (efectivo o transferencia) o dos (mixto)
  let partes;
  if (metodoPago === 'mixto') {
    const ef = parseFloat(document.getElementById('liq-pago-mixto-efectivo').value) || 0;
    const tr = parseFloat(document.getElementById('liq-pago-mixto-transferencia').value) || 0;
    if (ef < 0 || tr < 0 || Math.round(ef + tr) !== Math.round(monto)) {
      alert('El pago mixto no cuadra: efectivo + transferencia debe ser igual al monto.');
      return;
    }
    partes = [];
    if (ef > 0) partes.push({ metodo: 'efectivo', monto: ef });
    if (tr > 0) partes.push({ metodo: 'transferencia', monto: tr });
  } else {
    partes = [{ metodo: metodoPago, monto }];
  }

  const btn = document.getElementById('btn-guardar-liq-pago');
  if (btn.disabled) return;
  btn.disabled = true; btn.textContent = 'Guardando...';

  const ahora = new Date();
  const pago = { id: uid(), monto, metodoPago, fecha: fechaCO(ahora), hora: horaCO(ahora), ventaIds: [] };
  if (metodoPago === 'mixto') {
    pago.efectivo = (partes.find(x => x.metodo === 'efectivo') || {}).monto || 0;
    pago.transferencia = (partes.find(x => x.metodo === 'transferencia') || {}).monto || 0;
  }
  const ventasCreadas = [];
  const deshacerVentas = async () => {
    for (const v of ventasCreadas) await sheetsEscribir('delete', 'Ventas', null, v.id);
    const ids = ventasCreadas.map(v => v.id);
    DB.ventas = DB.ventas.filter(v => !ids.includes(v.id));
  };
  try {
    // El pago entra a la caja del día: una venta por cada método usado
    // (así efectivo y transferencia quedan bien separados en los reportes).
    const gananciaNegocio = l.items.reduce((a, it) => {
      const p = DB.productos.find(x => x.id === it.productoId);
      return a + (liqNum(it.precioLista) - (p ? p.pcompra : 0)) * liqCalcItem(it).venta;
    }, 0);
    const saldoDespues = Math.max(0, t.saldo - monto);
    for (const parte of partes) {
      const venta = {
        id: uid(), fecha: pago.fecha, hora: pago.hora, total: parte.monto,
        ganancia: t.total > 0 ? parte.monto * (gananciaNegocio / t.total) : 0,
        nota: 'Liquidación vendedor: ' + l.nombre + (metodoPago === 'mixto' ? ' (pago mixto)' : ''),
        metodoPago: parte.metodo,
        items: [{ ref: '-', nombre: 'Liquidación — ' + l.nombre, cantidad: 1, precio: parte.monto, total: parte.monto }],
        clienteId: l.clienteId, clienteNombre: l.nombre, clienteCedula: '', clienteTelefono: '', clienteDireccion: '',
        pagadoAhora: parte.monto, saldoPendiente: saldoDespues
      };
      DB.ventas.push(venta);
      ventasCreadas.push(venta);
      const okV = await sheetsEscribir('append', 'Ventas', [venta.id, venta.fecha, venta.hora, venta.total, venta.ganancia, venta.nota, venta.metodoPago, JSON.stringify(venta.items), venta.clienteId, venta.clienteNombre, venta.clienteCedula, venta.clienteTelefono, venta.clienteDireccion, venta.pagadoAhora, venta.saldoPendiente]);
      if (!okV) throw new Error('No se pudo guardar el pago en la hoja Ventas.');
      pago.ventaIds.push(venta.id);
    }

    l.pagos = l.pagos || [];
    l.pagos.push(pago);
    const okL = await sheetsEscribir('update', 'Liquidaciones', liqFila(l), l.id);
    if (!okL) {
      l.pagos.pop();
      throw new Error('Google Sheets no confirmó la actualización de la liquidación.');
    }

    liqActual = liqClonar(l);
    guardarLocal();
    cerrarModal('modal-liq-pago');
    renderLiqEditor();
    renderLiqHistorial();
    mostrarToast(liqTotales(l).saldo <= 0 ? 'Liquidación pagada completamente ✓' : `Pago guardado ✓ · ${fmt(monto)}`);
  } catch (e) {
    try { await deshacerVentas(); } catch (e2) { console.error(e2); }
    guardarLocal();
    console.error('Error guardando pago de liquidación:', e);
    alert('NO SE PUDO GUARDAR EL PAGO.\n\n' + (e && e.message ? e.message : String(e)));
  } finally {
    btn.disabled = false; btn.textContent = 'Registrar pago';
  }
}

// ---------- eliminar ----------
async function eliminarLiquidacion(id) {
  const l = DB.liquidaciones.find(x => x.id === id);
  if (!l) return;
  const t = liqTotales(l);
  let msg = `¿Eliminar la liquidación de ${l.nombre} (${l.fecha})?\n\nLos productos vendidos vuelven al inventario.`;
  if ((l.pagos || []).length) msg += `\nTambién se borran sus pagos (${fmt(t.pagado)}) de las ventas del día.`;
  if (!confirm(msg)) return;

  const ok = await sheetsEscribir('delete', 'Liquidaciones', null, id);
  if (!ok) { alert('No se pudo eliminar la liquidación en Google Sheets.'); return; }

  for (const p of (l.pagos || [])) {
    const ids = (p.ventaIds && p.ventaIds.length) ? p.ventaIds : (p.ventaId ? [p.ventaId] : []);
    for (const vid of ids) {
      await sheetsEscribir('delete', 'Ventas', null, vid);
      DB.ventas = DB.ventas.filter(v => v.id !== vid);
    }
  }
  for (const it of (l.items || [])) {
    const aplicado = Number(it.aplicado) || 0;
    const p = DB.productos.find(x => x.id === it.productoId);
    if (p && aplicado) {
      p.stock = p.stock + aplicado;
      await sheetsEscribir('update', 'Productos', [p.id, p.ref, p.nombre, p.pcompra, p.pventa1, p.pventa2, p.stock], p.id);
    }
  }
  DB.liquidaciones = DB.liquidaciones.filter(x => x.id !== id);
  if (liqActual && liqActual.id === id) { liqActual = null; liqMostrarVendedor(); renderLiqEditor(); }
  guardarLocal();
  renderLiqHistorial();
  mostrarToast('Liquidación eliminada');
}

// ---------- historial ----------
function renderLiqHistorial() {
  const cont = document.getElementById('liq-historial');
  if (!cont) return;
  const q = (document.getElementById('liq-hist-buscar')?.value || '').toLowerCase().trim();
  const lista = DB.liquidaciones.filter(l => !q || l.nombre.toLowerCase().includes(q)).slice().reverse();
  if (lista.length === 0) {
    cont.innerHTML = `<div class="estado-vacio"><i class="ti ti-truck-delivery"></i><p>Sin liquidaciones registradas.</p></div>`;
    return;
  }
  const filas = lista.map(l => {
    const t = liqTotales(l);
    const badge = t.total > 0 && t.saldo <= 0 ? '<span class="badge ok">Pagada</span>'
      : t.pagado > 0 ? '<span class="badge alerta">Abonada</span>' : '<span class="badge danger">Pendiente</span>';
    return `<tr>
      <td>${esc(l.fecha)}<div style="font-size:11px;color:var(--texto2)">${esc(l.hora || '')}</div></td>
      <td>${esc(l.nombre)}</td>
      <td style="text-align:center">${t.unidades}</td>
      <td>${fmt(t.total)}</td>
      <td>${fmt(t.pagado)}</td>
      <td style="font-weight:500">${fmt(t.saldo)}</td>
      <td>${badge}</td>
      <td><div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn-primary btn-abrir-liq" data-id="${l.id}" style="padding:6px 10px" title="Abrir / editar"><i class="ti ti-edit"></i></button>
        <button class="btn-secundario btn-imprimir-liq" data-id="${l.id}" style="padding:6px 10px" title="Imprimir"><i class="ti ti-printer"></i></button>
        <button class="btn-peligro btn-eliminar-liq" data-id="${l.id}" style="padding:6px 10px" title="Eliminar"><i class="ti ti-trash"></i></button>
      </div></td>
    </tr>`;
  }).join('');
  cont.innerHTML = `<div class="tabla-wrap"><table>
    <thead><tr><th>Fecha</th><th>Vendedor</th><th>Unid.</th><th>Total a pagar</th><th>Pagado</th><th>Saldo</th><th>Estado</th><th>Acciones</th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;
  cont.querySelectorAll('.btn-abrir-liq').forEach(b => b.addEventListener('click', () => abrirLiquidacion(b.dataset.id)));
  cont.querySelectorAll('.btn-imprimir-liq').forEach(b => b.addEventListener('click', () => {
    const l = DB.liquidaciones.find(x => x.id === b.dataset.id); if (l) imprimirLiquidacion(l);
  }));
  cont.querySelectorAll('.btn-eliminar-liq').forEach(b => b.addEventListener('click', () => eliminarLiquidacion(b.dataset.id)));
}

// ---------- impresión ----------
function imprimirLiquidacion(l) {
  if (!l) return;
  const t = liqTotales(l);
  const conMovimiento = l.items.filter(it => liqNum(it.cargue) + liqNum(it.recargue) + liqNum(it.devolucion) > 0);
  if (conMovimiento.length === 0) { alert('No hay productos con cargue para imprimir.'); return; }
  const n = v => (liqNum(v) ? liqNum(v) : '');

  const filas = conMovimiento.map(it => {
    const c = liqCalcItem(it);
    return `<tr>
      <td>${esc(it.nombre)}</td>
      <td class="num">${n(it.cargue)}</td><td class="num">${n(it.recargue)}</td><td class="num">${n(it.devolucion)}</td>
      <td class="num"><strong>${c.venta}</strong></td>
      <td class="num">${fmt(liqNum(it.precioLista))}</td><td class="num">${fmt(c.valor)}</td>
      <td class="num">${fmt(liqNum(it.precioPublico))}</td><td class="num">${fmt(c.ventaCI)}</td><td class="num">${fmt(c.ganancia)}</td>
    </tr>`;
  }).join('');

  const pagos = (l.pagos || []).map((p, i) => `
    <tr><td>${i + 1}</td><td>${esc(p.fecha || '')} ${esc(p.hora || '')}</td>
    <td>${liqTextoMetodo(p, false)}</td><td class="num">${fmt(p.monto)}</td></tr>`).join('');

  document.getElementById('liquidacion-print-contenido').innerHTML = `
    <div id="tp-header">
      <h1>Crem Helado</h1>
      <p>Liquidación de vendedor</p>
    </div>
    <div id="tp-meta">
      <span><strong>Vendedor:</strong> ${esc(l.nombre)}</span>
      <span><strong>Fecha:</strong> ${esc(l.fecha)} ${esc(l.hora || '')}</span>
    </div>
    <table>
      <thead><tr><th>Producto</th><th class="num">Cargue</th><th class="num">Recargue</th><th class="num">Devol.</th><th class="num">Venta</th>
      <th class="num">P. lista</th><th class="num">Valor total</th><th class="num">P. público</th><th class="num">Venta CI</th><th class="num">Ganancia CI</th></tr></thead>
      <tbody>${filas}</tbody>
      <tfoot><tr style="font-weight:700"><td colspan="4">TOTAL</td><td class="num">${t.unidades}</td><td></td>
        <td class="num">${fmt(t.total)}</td><td></td><td class="num">${fmt(t.ventaCI)}</td><td class="num">${fmt(t.ganancia)}</td></tr></tfoot>
    </table>
    <p style="margin-top:12px;font-size:14px"><strong>Total a pagar: ${fmt(t.total)}</strong> · Pagado: ${fmt(t.pagado)} · <strong>Saldo: ${fmt(t.saldo)}</strong></p>
    ${pagos ? `<p style="margin-top:10px;font-size:12px"><strong>Pagos realizados</strong></p>
      <table style="width:60%"><thead><tr><th>#</th><th>Fecha</th><th>Método</th><th class="num">Monto</th></tr></thead><tbody>${pagos}</tbody></table>` : ''}
    <div id="tp-firmas">
      <div class="tp-firma"><div class="tp-linea"></div>Vendedor</div>
      <div class="tp-firma"><div class="tp-linea"></div>Recibe — Crem Helado</div>
    </div>`;
  prepararImpresion('liquidacion-print');
  window.print();
}

// =============================================
// NAVEGACIÓN CON TECLADO
// =============================================
// Permite moverse con ↑/↓ entre botones/campos de un contenedor (Enter ya activa el botón enfocado)
function habilitarNavegacionFlechas(contenedorId) {
  const contenedor = document.getElementById(contenedorId);
  contenedor.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const focusables = Array.from(contenedor.querySelectorAll('button:not([disabled]), input'))
      .filter(el => el.offsetParent !== null);
    if (focusables.length === 0) return;
    const idx = focusables.indexOf(document.activeElement);
    e.preventDefault();
    if (idx === -1) { focusables[0].focus(); return; }
    const next = e.key === 'ArrowDown' ? idx + 1 : idx - 1;
    focusables[Math.max(0, Math.min(focusables.length - 1, next))].focus();
  });
}

// Enter avanza al siguiente campo del formulario; en el último, ejecuta onFinal
function habilitarEnterAvanza(ids, onFinal) {
  ids.forEach((id, i) => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const siguiente = ids[i+1];
      if (siguiente) document.getElementById(siguiente).focus();
      else onFinal();
    });
  });
}

// =============================================
// EVENTOS
// =============================================
document.addEventListener('DOMContentLoaded', () => {
  cargarLocal();
  if (DB.usuarios.length===0) DB.usuarios=[{user:'admin',pass:'CremHelado2812',rol:'admin'}];
  if (DB.config.trasladoContador === undefined) DB.config.trasladoContador = 0;
  if (!DB.clientes) DB.clientes = [];
  if (!DB.deudores) DB.deudores = [];
  if (!DB.anticipos) DB.anticipos = [];
  if (!DB.proveedores) DB.proveedores = [];
  if (!DB.gastos) DB.gastos = [];
  if (!DB.costos) DB.costos = [];
  if (!DB.traslados) DB.traslados = [];
  if (!DB.liquidaciones) DB.liquidaciones = [];

  // Sesión persistente
  const sesionGuardada = cargarSesion();
  if (sesionGuardada) {
    const valido = DB.usuarios.find(u=>u.user===sesionGuardada.user&&u.pass===sesionGuardada.pass);
    if (valido) { sesion=valido; entrarAlApp(); sincronizar(VENTAS_DIAS_SYNC_LIGERO); }
  }

  // Login
  document.getElementById('btn-login').addEventListener('click', doLogin);
  document.getElementById('login-pass').addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); });

  // Logout
  document.getElementById('btn-logout').addEventListener('click', doLogout);

  // Navegación
  document.querySelectorAll('.nav-tab').forEach(t=>t.addEventListener('click',()=>mostrarPanel(t.dataset.tab)));
  document.querySelector('[data-goto="ventas"]').addEventListener('click',()=>mostrarPanel('ventas'));

  // Menú lateral (móvil)
  document.getElementById('btn-menu-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('abierto');
    document.getElementById('sidebar-backdrop').classList.toggle('visible');
  });
  document.getElementById('sidebar-backdrop').addEventListener('click', cerrarSidebarMovil);

  // Cerrar modales
  document.querySelectorAll('.btn-cerrar-modal').forEach(b=>b.addEventListener('click',()=>cerrarModal(b.dataset.modal)));
  document.querySelectorAll('.modal-bg').forEach(bg=>bg.addEventListener('click',e=>{ if(e.target===bg) bg.classList.add('hidden'); }));

  // Inventario
  document.getElementById('btn-abrir-modal-producto').addEventListener('click',()=>abrirModalProducto(null));
  document.getElementById('btn-guardar-producto').addEventListener('click', guardarProducto);
  document.getElementById('inv-search').addEventListener('input', () => { inventarioMostrar = 10; renderInventario(); });

  // Lector de código de barras en Inventario: al escanear y llegar el Enter,
  // si el código coincide EXACTO con la Ref propia o el código de barras
  // de un producto ya existente se abre directo su ficha para editar (por
  // ejemplo, para sumarle stock); si el código no existe todavía (un
  // repuesto nuevo que trae código de fábrica), se abre "Agregar producto"
  // con el código de barras ya lleno, lista solo para poner la Ref propia,
  // el nombre y los precios.
  document.getElementById('inv-search').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const q = document.getElementById('inv-search').value.trim();
    if (!q) return;
    const coincidenciaExacta = DB.productos.find(p => productoCoincideExacto(p, q));
    if (coincidenciaExacta) {
      abrirModalProducto(coincidenciaExacta.id);
    } else {
      abrirModalProducto(null, q);
    }
  });
  habilitarEnterAvanza(['prod-codigobarras','prod-ref','prod-nombre','prod-pcompra','prod-pventa1','prod-pventa2','prod-stock'], guardarProducto);

  // Factura / boucher
  document.getElementById('btn-imprimir-boucher').addEventListener('click', () => {
    if (facturaVentaActual) imprimirBoucher(facturaVentaActual);
  });

  // PIN
  document.getElementById('btn-verificar-pin').addEventListener('click', verificarPin);
  document.getElementById('pin-input').addEventListener('keydown',e=>{ if(e.key==='Enter') verificarPin(); });

  // Clave de secciones privadas
  document.getElementById('btn-verificar-clave-panel').addEventListener('click', verificarClavePanel);
  document.getElementById('clave-panel-input').addEventListener('keydown', e=>{ if(e.key==='Enter') verificarClavePanel(); });

  // Ventas — búsqueda con flechas y Enter
  const ventaSearch = document.getElementById('venta-search');
  ventaSearch.addEventListener('input', buscarProductoVenta);
  ventaSearch.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();

      // Escaneo de código de barras: el texto tecleado coincide EXACTO con
      // la Ref propia o con el código de barras de fábrica de un producto
      // → se agrega directo al carrito sin abrir modal, para poder seguir
      // escaneando de corrido.
      const q = ventaSearch.value.trim();
      const coincidenciaExacta = q
        ? DB.productos.find(p => productoCoincideExacto(p, q))
        : null;

      if (coincidenciaExacta) {
        agregarProductoEscaneado(coincidenciaExacta);
        return;
      }

      // Búsqueda manual por nombre (sin coincidencia exacta de código):
      // se usa el flujo normal con cantidad y elección de precio.
      if (resultadosVenta.length === 0) return;
      const p = resultadosVenta[indiceVenta];
      if (p) abrirFlujRapido(p.id);
      return;
    }

    if (resultadosVenta.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      indiceVenta = Math.min(indiceVenta + 1, resultadosVenta.length - 1);
      renderResultadosVenta();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      indiceVenta = Math.max(indiceVenta - 1, 0);
      renderResultadosVenta();
    }
  });

  document.getElementById('btn-limpiar-carrito').addEventListener('click',()=>{ carrito=[]; renderCarrito(); });
  document.getElementById('btn-confirmar-venta').addEventListener('click', confirmarVenta);
  document.getElementById('pef-recibido').addEventListener('input', actualizarCambioPago);
  document.getElementById('btn-pef-continuar').addEventListener('click', confirmarPagoEfectivo);

  document.querySelectorAll('input[name="metodo-pago"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const mixto = document.querySelector('input[name="metodo-pago"]:checked').value === 'mixto';
      document.getElementById('pago-mixto-box').classList.toggle('hidden', !mixto);
    });
  });

  ['pago-mixto-efectivo','pago-mixto-transferencia'].forEach(idInput => {
    document.getElementById(idInput).addEventListener('input', actualizarRestantePagoMixto);
  });

  function actualizarRestantePagoMixto() {
    const total = carrito.reduce((a,i)=>a+i.total,0);
    const efectivo = parseFloat(document.getElementById('pago-mixto-efectivo').value)||0;
    const transferencia = parseFloat(document.getElementById('pago-mixto-transferencia').value)||0;
    const restante = total - efectivo - transferencia;
    document.getElementById('pago-mixto-restante').textContent =
      restante === 0 ? 'Cuadrado ✓' : `Falta: ${fmt(Math.abs(restante))}`;
  }

  // Modal precio (carrito)
  document.getElementById('mpv-btn-precio1').addEventListener('click',()=>seleccionarPrecio(1));
  document.getElementById('mpv-btn-precio2').addEventListener('click',()=>seleccionarPrecio(2));
  document.getElementById('btn-aplicar-precio').addEventListener('click', aplicarPrecioCustom);
  habilitarNavegacionFlechas('modal-precio');
  habilitarNavegacionFlechas('modal-rapido');

  // Flujo rápido — cantidad
  document.getElementById('btn-rapido-siguiente').addEventListener('click', rapidoMostrarPrecio);
  document.getElementById('rapido-cantidad').addEventListener('keydown', e=>{ if(e.key==='Enter') rapidoMostrarPrecio(); });

  // Flujo rápido — precio
  document.getElementById('rapido-btn-p1').addEventListener('click',()=>{
    rapidoAgregarConPrecio(rapidoProductoActual.pventa1);
  });
  document.getElementById('rapido-btn-p2').addEventListener('click',()=>{
    rapidoAgregarConPrecio(rapidoProductoActual.pventa2);
  });
  document.getElementById('rapido-btn-custom').addEventListener('click',()=>{
    const v = parseFloat(document.getElementById('rapido-precio-custom').value);
    if (!v||v<0) { alert('Ingresa un precio válido'); return; }
    rapidoAgregarConPrecio(v);
  });
  document.getElementById('rapido-precio-custom').addEventListener('keydown',e=>{
    if (e.key==='Enter') {
      const v=parseFloat(document.getElementById('rapido-precio-custom').value);
      if (v&&v>0) rapidoAgregarConPrecio(v);
    }
  });

  // Traslado — búsqueda con flechas y Enter
  const trasladoSearch = document.getElementById('traslado-search');
  trasladoSearch.addEventListener('input', buscarProductoTraslado);
  trasladoSearch.addEventListener('keydown', e => {
    if (resultadosTraslado.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      indiceTraslado = Math.min(indiceTraslado + 1, resultadosTraslado.length - 1);
      renderResultadosTraslado();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      indiceTraslado = Math.max(indiceTraslado - 1, 0);
      renderResultadosTraslado();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const p = resultadosTraslado[indiceTraslado];
      if (p) agregarATraslado(p.id);
    }
  });
  document.getElementById('btn-limpiar-traslado').addEventListener('click', () => {
    if (traslado.length===0) return;
    if (!confirm('¿Vaciar la lista de traslado?')) return;
    traslado = []; renderTraslado();
  });
  document.getElementById('btn-imprimir-traslado').addEventListener('click', imprimirTraslado);
  document.getElementById('btn-ct-agregar').addEventListener('click', confirmarCantidadTraslado);
  document.getElementById('ct-cantidad').addEventListener('keydown', e => { if (e.key==='Enter') confirmarCantidadTraslado(); });

  const cotizacionSearch = document.getElementById('cotizacion-search');
  inicializarBuscadorCliente('cotizacion', 'cotizacion-cliente-buscar', 'cotizacion-cliente-resultados', seleccionarClienteCotizacion);
  document.getElementById('btn-quitar-cliente-cotizacion').addEventListener('click', quitarClienteCotizacion);
  cotizacionSearch.addEventListener('input', buscarProductoCotizacion);
  cotizacionSearch.addEventListener('keydown', e => {
    if (resultadosCotizacion.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      indiceCotizacion = Math.min(indiceCotizacion + 1, resultadosCotizacion.length - 1);
      renderResultadosCotizacion();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      indiceCotizacion = Math.max(indiceCotizacion - 1, 0);
      renderResultadosCotizacion();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const p = resultadosCotizacion[indiceCotizacion];
      if (p) agregarACotizacion(p.id);
    }
  });
  document.getElementById('btn-limpiar-cotizacion').addEventListener('click', limpiarCotizacion);
  document.getElementById('btn-imprimir-cotizacion').addEventListener('click', imprimirCotizacion);
  document.getElementById('btn-cq-agregar').addEventListener('click', confirmarCantidadCotizacion);
  document.getElementById('cq-precio').addEventListener('keydown', e => { if (e.key==='Enter') confirmarCantidadCotizacion(); });

  // Clientes
  inicializarBuscadorCliente('venta', 'venta-cliente-buscar', 'venta-cliente-resultados', seleccionarClienteVenta);
  document.getElementById('btn-nuevo-cliente-venta').addEventListener('click', () => abrirModalNuevoCliente('venta'));
  document.getElementById('btn-quitar-cliente-venta').addEventListener('click', quitarClienteVenta);
  document.getElementById('btn-guardar-cliente').addEventListener('click', guardarCliente);
  document.getElementById('btn-abrir-modal-cliente').addEventListener('click', () => abrirModalNuevoCliente('clientes'));
  document.getElementById('clientes-search').addEventListener('input', renderClientes);
  habilitarEnterAvanza(['cliente-nombre','cliente-tipodoc','cliente-cedula','cliente-telefono','cliente-direccion','cliente-correo'], guardarCliente);

  // Deudores
  inicializarBuscadorCliente('deudor', 'deudor-cliente-buscar', 'deudor-cliente-resultados', seleccionarClienteDeudor);
  document.getElementById('btn-nuevo-cliente-deudor').addEventListener('click', () => abrirModalNuevoCliente('deudor'));
  document.getElementById('btn-quitar-cliente-deudor').addEventListener('click', quitarClienteDeudor);
  inicializarBuscadorProducto('deudor', 'deudor-producto-buscar', 'deudor-producto-resultados', agregarProductoDeudor);
  document.getElementById('btn-abrir-modal-deudor').addEventListener('click', () => abrirModalDeudor(null));
  document.getElementById('btn-guardar-deudor').addEventListener('click', guardarDeudor);
  document.getElementById('btn-guardar-abono').addEventListener('click', guardarAbono);
  document.getElementById('abono-monto').addEventListener('keydown', e => { if (e.key==='Enter') guardarAbono(); });

  // Anticipos
  inicializarBuscadorCliente('anticipo', 'anticipo-cliente-buscar', 'anticipo-cliente-resultados', seleccionarClienteAnticipo);
  document.getElementById('btn-nuevo-cliente-anticipo').addEventListener('click', () => abrirModalNuevoCliente('anticipo'));
  document.getElementById('btn-quitar-cliente-anticipo').addEventListener('click', quitarClienteAnticipo);
  inicializarBuscadorProducto('anticipo', 'anticipo-producto-buscar', 'anticipo-producto-resultados', agregarProductoAnticipo);
  document.getElementById('btn-abrir-modal-anticipo').addEventListener('click', () => abrirModalAnticipo(null));
  document.getElementById('btn-guardar-anticipo').addEventListener('click', guardarAnticipo);

  // Proveedores
  document.getElementById('btn-abrir-modal-proveedor').addEventListener('click', abrirModalProveedor);
  document.getElementById('btn-guardar-proveedor').addEventListener('click', guardarProveedor);
  document.getElementById('btn-guardar-abono-proveedor').addEventListener('click', guardarAbonoProveedor);
  document.getElementById('abono-proveedor-monto').addEventListener('keydown', e => { if (e.key==='Enter') guardarAbonoProveedor(); });

  // Gastos
  document.getElementById('btn-abrir-modal-gasto').addEventListener('click', abrirModalGasto);
  document.getElementById('btn-guardar-gasto').addEventListener('click', guardarGasto);
  document.querySelectorAll('input[name="gasto-metodo"]').forEach(r => r.addEventListener('change', gastoActualizarMixto));
  document.getElementById('gasto-monto').addEventListener('input', () => {
    if (document.querySelector('input[name="gasto-metodo"]:checked').value === 'mixto') gastoMixtoDesde('monto');
  });
  document.getElementById('gasto-mixto-efectivo').addEventListener('input', () => gastoMixtoDesde('ef'));
  document.getElementById('gasto-mixto-transferencia').addEventListener('input', () => gastoMixtoDesde('tr'));
  document.querySelectorAll('.gasto-cat-btn').forEach(b =>
    b.addEventListener('click', () => seleccionarCategoriaGasto(b.dataset.cat, b)));

  // Costos
  document.getElementById('btn-abrir-modal-costo').addEventListener('click', abrirModalCosto);
  document.getElementById('btn-guardar-costo').addEventListener('click', guardarCosto);
  document.querySelectorAll('input[name="costo-metodo"]').forEach(r => r.addEventListener('change', costoActualizarMixto));
  document.getElementById('costo-monto').addEventListener('input', () => {
    if (document.querySelector('input[name="costo-metodo"]:checked').value === 'mixto') costoMixtoDesde('monto');
  });
  document.getElementById('costo-mixto-efectivo').addEventListener('input', () => costoMixtoDesde('ef'));
  document.getElementById('costo-mixto-transferencia').addEventListener('input', () => costoMixtoDesde('tr'));
  document.querySelectorAll('.costo-cat-btn').forEach(b =>
    b.addEventListener('click', () => seleccionarCategoriaCosto(b.dataset.cat, b)));

  // Nota crédito

  // Historial
  document.getElementById('hist-fecha').addEventListener('change', renderHistorial);

  // Reportes
  const limpiarEspecificos = () => {
    reporteDiaEsp = ''; reporteSemEsp = ''; reporteMesEsp = '';
    ['rep-dia','rep-sem','rep-mes'].forEach(id => { document.getElementById(id).value = ''; });
  };
  document.querySelectorAll('.btn-reporte').forEach(b =>
    b.addEventListener('click', () => { limpiarEspecificos(); renderReportes(b.dataset.periodo); }));
  document.getElementById('rep-dia').addEventListener('change', e => {
    const v = e.target.value; limpiarEspecificos(); e.target.value = v; reporteDiaEsp = v;
    renderReportes(v ? 'dia-esp' : 'semana');
  });
  document.getElementById('rep-sem').addEventListener('change', e => {
    const v = e.target.value; limpiarEspecificos(); e.target.value = v; reporteSemEsp = v;
    renderReportes(v ? 'semana-esp' : 'semana');
  });
  document.getElementById('rep-mes').addEventListener('change', e => {
    const v = e.target.value; limpiarEspecificos(); e.target.value = v; reporteMesEsp = v;
    renderReportes(v ? 'mes-esp' : 'semana');
  });

  // Precios por cliente
  inicializarBuscadorCliente('pre', 'pre-cliente-buscar', 'pre-cliente-resultados', seleccionarClientePrecios);
  document.getElementById('btn-quitar-cliente-pre').addEventListener('click', quitarClientePrecios);
  inicializarBuscadorProducto('pre', 'pre-producto-buscar', 'pre-producto-resultados', agregarProductoPrecios);

  // Liquidación de vendedores
  inicializarBuscadorCliente('liq', 'liq-cliente-buscar', 'liq-cliente-resultados', seleccionarVendedorLiq);
  document.getElementById('btn-quitar-cliente-liq').addEventListener('click', quitarVendedorLiq);
  inicializarBuscadorProducto('liq', 'liq-producto-buscar', 'liq-producto-resultados', agregarProductoLiq);
  document.getElementById('btn-liq-nueva').addEventListener('click', nuevaLiquidacion);
  document.getElementById('liq-hist-buscar').addEventListener('input', renderLiqHistorial);
  document.getElementById('btn-guardar-liq-pago').addEventListener('click', guardarPagoLiq);
  document.getElementById('liq-pago-monto').addEventListener('keydown', e => { if (e.key==='Enter') guardarPagoLiq(); });
  document.querySelectorAll('input[name="liq-pago-metodo"]').forEach(r => r.addEventListener('change', () => {
    const mixto = document.querySelector('input[name="liq-pago-metodo"]:checked').value === 'mixto';
    document.getElementById('liq-pago-mixto-box').classList.toggle('hidden', !mixto);
    if (mixto) {
      document.getElementById('liq-pago-mixto-efectivo').value = parseFloat(document.getElementById('liq-pago-monto').value) || 0;
      document.getElementById('liq-pago-mixto-transferencia').value = 0;
      liqActualizarMixto();
    }
  }));
  document.getElementById('liq-pago-monto').addEventListener('input', () => {
    if (document.querySelector('input[name="liq-pago-metodo"]:checked').value === 'mixto') {
      document.getElementById('liq-pago-mixto-efectivo').value = parseFloat(document.getElementById('liq-pago-monto').value) || 0;
      document.getElementById('liq-pago-mixto-transferencia').value = 0;
      liqActualizarMixto();
    }
  });
  // al escribir el efectivo, la transferencia se completa sola con lo que falta
  document.getElementById('liq-pago-mixto-efectivo').addEventListener('input', () => {
    const monto = parseFloat(document.getElementById('liq-pago-monto').value) || 0;
    const ef = parseFloat(document.getElementById('liq-pago-mixto-efectivo').value) || 0;
    document.getElementById('liq-pago-mixto-transferencia').value = Math.max(0, monto - ef);
    liqActualizarMixto();
  });
  document.getElementById('liq-pago-mixto-transferencia').addEventListener('input', liqActualizarMixto);

  // Config
  document.getElementById('btn-agregar-usuario').addEventListener('click', agregarUsuario);
  document.getElementById('btn-guardar-config').addEventListener('click', guardarConfig);
  const btnProbarImpresora = document.getElementById('btn-probar-impresora');
  if (btnProbarImpresora) btnProbarImpresora.addEventListener('click', probarImpresoraPOS);
});