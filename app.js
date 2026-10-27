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
const SECCIONES_PROTEGIDAS = ['inventario','historial','reportes','config'];
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
      cambio: (f[16]!==undefined&&f[16]!=='') ? Number(f[16]) : undefined
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
      nota: String(f[6]||'')
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
    await sheetsEscribir('append', 'Ventas', ['ID','Fecha','Hora','Total','Ganancia','Nota','MetodoPago','Items','ClienteId','ClienteNombre','ClienteCedula','ClienteTelefono','ClienteDireccion','PagadoAhora','SaldoPendiente','PagoRecibido','Cambio']);
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
    await sheetsEscribir('append', 'Gastos', ['ID','Categoria','Monto','MetodoPago','Fecha','Hora','Nota']);
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
  abrirModal('modal-gasto');
}

async function guardarGasto() {
  const monto = parseFloat(document.getElementById('gasto-monto').value)||0;
  const metodoPago = document.querySelector('input[name="gasto-metodo"]:checked').value;
  const nota = document.getElementById('gasto-nota').value.trim();
  if (!gastoCategoriaSeleccionada) { alert('Selecciona una categoría de gasto'); return; }
  if (!monto || monto<=0) { alert('Ingresa un monto válido'); return; }

  const ahora = new Date();
  const gasto = { id: uid(), categoria: gastoCategoriaSeleccionada, monto, metodoPago, fecha: fechaCO(ahora), hora: horaCO(ahora), nota };
  DB.gastos.push(gasto);
  await sheetsEscribir('append','Gastos',[gasto.id,gasto.categoria,gasto.monto,gasto.metodoPago,gasto.fecha,gasto.hora,gasto.nota]);

  guardarLocal();
  cerrarModal('modal-gasto');
  renderGastos();
  renderDashboard();
  mostrarToast('Gasto registrado ✓');
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
  const efectivoMes = gastosMes.filter(g=>g.metodoPago!=='transferencia').reduce((a,g)=>a+g.monto,0);
  const transferenciaMes = gastosMes.filter(g=>g.metodoPago==='transferencia').reduce((a,g)=>a+g.monto,0);

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
      <td><span class="badge ${g.metodoPago==='transferencia'?'rosa':'verde'}">${g.metodoPago==='transferencia'?'🏦 Transferencia':'💵 Efectivo'}</span></td>
      <td style="font-size:13px;color:var(--texto2)">${esc(g.nota)||'-'}</td>
      <td><button class="btn-peligro btn-eliminar-gasto" data-id="${g.id}" style="padding:5px 9px"><i class="ti ti-trash"></i></button></td>
    </tr>`).join('');

  cont.innerHTML = `<div class="tabla-wrap"><table>
    <thead><tr><th>Fecha</th><th>Categoría</th><th>Monto</th><th>Método</th><th>Nota</th><th></th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;

  cont.querySelectorAll('.btn-eliminar-gasto').forEach(b => b.addEventListener('click', () => eliminarGasto(b.dataset.id)));
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
  const totalVendido = totalVendidoBruto - gastosHoy;
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
    <div class="metric"><div class="mlabel">Transacciones</div><div class="mvalue">${ventasHoy.length}</div></div>
    <div class="metric"><div class="mlabel">Productos</div><div class="mvalue">${DB.productos.length}</div></div>
    ${stockBajo>0?`<div class="metric alerta metric-clickeable" data-stock="bajo"><div class="mlabel">Stock bajo</div><div class="mvalue">${stockBajo}</div></div>`:''}
    ${sinStock>0?`<div class="metric danger metric-clickeable" data-stock="sin"><div class="mlabel">Sin stock</div><div class="mvalue">${sinStock}</div></div>`:''}
    ${deudasVencidas>0?`<div class="metric danger"><div class="mlabel">Deudas vencidas</div><div class="mvalue">${deudasVencidas}</div></div>`:''}
    ${anticiposVencidos>0?`<div class="metric danger"><div class="mlabel">Anticipos vencidos</div><div class="mvalue">${anticiposVencidos}</div></div>`:''}
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
function imprimirBoucherHTML(venta) {
  const metodoTexto = venta.metodoPago === 'transferencia' ? 'Transferencia' : 'Efectivo';

  const filas = venta.items.map(i => `
    <tr>
      <td>${esc(i.ref||'-')}</td>
      <td>${esc(i.nombre)}</td>
      <td style="text-align:center">${i.cantidad}</td>
      <td style="text-align:right">${fmt(i.precio)}</td>
    </tr>`).join('');

  document.getElementById('venta-print-contenido').innerHTML = `
    <div id="tp-header">
      <h1>Crem Helado</h1>
      <p>Comprobante de venta</p>
    </div>
    <div id="tp-meta">
      <span><strong>Fecha:</strong> ${venta.fecha}</span>
      <span><strong>Hora:</strong> ${venta.hora}</span>
    </div>
    ${venta.clienteNombre?`
    <p style="font-size:13px;margin-bottom:4px"><strong>Cliente:</strong> ${esc(venta.clienteNombre)}</p>
    <p style="font-size:13px;margin-bottom:4px"><strong>Cédula:</strong> ${esc(venta.clienteCedula||'-')}</p>
    ${venta.clienteTelefono?`<p style="font-size:13px;margin-bottom:4px"><strong>Teléfono:</strong> ${esc(venta.clienteTelefono)}</p>`:''}
    ${venta.clienteDireccion?`<p style="font-size:13px;margin-bottom:10px"><strong>Dirección:</strong> ${esc(venta.clienteDireccion)}</p>`:''}
    `:''}
    ${venta.nota?`<p style="font-size:13px;margin-bottom:10px"><strong>Nota:</strong> ${esc(venta.nota)}</p>`:''}
    <table>
      <thead><tr><th>Código</th><th>Producto</th><th>Cant.</th><th>Precio</th></tr></thead>
      <tbody>${filas}</tbody>
    </table>
    <p style="margin-top:12px;font-size:14px;text-align:right"><strong>${venta.saldoPendiente!==undefined?'Pagado ahora':'Total'}: ${fmt(venta.total)}</strong></p>
    ${venta.saldoPendiente!==undefined?`<p style="margin-top:4px;font-size:14px;text-align:right;color:#A32D2D"><strong>Falta por cancelar: ${fmt(venta.saldoPendiente)}</strong></p>`:''}
    ${venta.pagoRecibido!==undefined?`
    <p style="margin-top:4px;font-size:13px;text-align:right">Pago recibido: ${fmt(venta.pagoRecibido)}</p>
    <p style="margin-top:2px;font-size:14px;text-align:right"><strong>Cambio: ${fmt(venta.cambio||0)}</strong></p>`:''}
    <p style="margin-top:4px;font-size:12px;text-align:right">Método de pago: ${metodoTexto}</p>
    <p style="text-align:center;margin-top:20px;font-size:12px">¡Gracias por tu compra!</p>
  `;

  prepararImpresion('venta-print');
  window.print();
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
    pagoRecibido: pagoEfectivoRecibido!=null?pagoEfectivoRecibido:undefined, cambio
  };
  DB.ventas.push(venta);
  await sheetsEscribir('append','Ventas',[venta.id,venta.fecha,venta.hora,venta.total,venta.ganancia,venta.nota,venta.metodoPago,JSON.stringify(venta.items),venta.clienteId,venta.clienteNombre,venta.clienteCedula,venta.clienteTelefono,venta.clienteDireccion,'','',venta.pagoRecibido!=null?venta.pagoRecibido:'',venta.cambio!=null?venta.cambio:'']);

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
  const efectivo=ventas.filter(v=>v.metodoPago!=='transferencia').reduce((a,v)=>a+v.total,0);
  const transferencia=ventas.filter(v=>v.metodoPago==='transferencia').reduce((a,v)=>a+v.total,0);

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
      <td><span class="badge ${v.metodoPago==='transferencia'?'rosa':'verde'}">${v.metodoPago==='transferencia'?'🏦 Transferencia':'💵 Efectivo'}</span></td>
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
  } else {
    desde = new Date(hoy.getFullYear(), 0, 1);
    hasta = new Date(hoy); hasta.setHours(23,59,59,999);
  }

  return { desde, hasta };
}

function renderReportes(periodo) {
  periodoreporte = periodo;

  // Actualizar botones activos
  document.querySelectorAll('.btn-reporte').forEach(b => {
    b.classList.toggle('active', b.dataset.periodo === periodo);
  });

  const { desde, hasta } = getRangoPeriodo(periodo);
  const ventas = DB.ventas.filter(v => {
    const d = parseFechaCO(v.fecha);
    return d >= desde && d <= hasta;
  });

  const totalVendido   = ventas.reduce((a,v)=>a+v.total,0);
  const totalGanancia  = ventas.reduce((a,v)=>a+v.ganancia,0);
  const totalEfectivo  = ventas.filter(v=>v.metodoPago!=='transferencia').reduce((a,v)=>a+v.total,0);
  const totalTransf    = ventas.filter(v=>v.metodoPago==='transferencia').reduce((a,v)=>a+v.total,0);
  const ganEfectivo    = ventas.filter(v=>v.metodoPago!=='transferencia').reduce((a,v)=>a+v.ganancia,0);
  const ganTransf      = ventas.filter(v=>v.metodoPago==='transferencia').reduce((a,v)=>a+v.ganancia,0);

  const labels = { dia:'hoy', semana:'esta semana', mes:'este mes', año:'este año' };

  // Métricas principales — solo ventas, sin mezclar gastos
  document.getElementById('reporte-metrics').innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:1.5rem">
      <div class="metric rosa"><div class="mlabel">Total vendido ${labels[periodo]}</div><div class="mvalue">${fmt(totalVendido)}</div></div>
      <div class="metric dorado"><div class="mlabel">Ganancia ${labels[periodo]}</div><div class="mvalue">${fmt(totalGanancia)}</div></div>
      <div class="metric"><div class="mlabel">Transacciones</div><div class="mvalue">${ventas.length}</div></div>
    </div>`;

  // Desglose por método de pago — ventas
  document.getElementById('reporte-pago').innerHTML = `
    <div class="reporte-pago-card">
      <span class="rp-icon">💵</span>
      <div class="rp-label">Ventas en Efectivo</div>
      <div class="rp-value">${fmt(totalEfectivo)}</div>
      <div class="rp-sub">Ganancia: ${fmt(ganEfectivo)}</div>
    </div>
    <div class="reporte-pago-card">
      <span class="rp-icon">🏦</span>
      <div class="rp-label">Ventas por Transferencia</div>
      <div class="rp-value">${fmt(totalTransf)}</div>
      <div class="rp-sub">Ganancia: ${fmt(ganTransf)}</div>
    </div>
    <div class="reporte-pago-card" style="border:0.5px solid var(--rosa-medio)">
      <span class="rp-icon">📊</span>
      <div class="rp-label">Total combinado</div>
      <div class="rp-value">${fmt(totalVendido)}</div>
      <div class="rp-sub">Ganancia total: ${fmt(totalGanancia)}</div>
    </div>`;

  // Resumen neto del mes: siempre el mes actual, independiente del periodo elegido arriba
  renderResumenNetoMes();
}

// Resumen neto del mes actual: ganancia de ventas menos gastos, y ventas menos pagos a proveedores.
// Siempre calculado para el mes en curso (se "reinicia" solo porque nunca acumula meses anteriores).
function renderResumenNetoMes() {
  const hoy = new Date();
  const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const finMes = new Date(hoy.getFullYear(), hoy.getMonth()+1, 0, 23,59,59,999);

  const ventasMes = DB.ventas.filter(v => { const d = parseFechaCO(v.fecha); return d>=inicioMes && d<=finMes; });
  const gastosMes = DB.gastos.filter(g => { const d = parseFechaCO(g.fecha); return d>=inicioMes && d<=finMes; });

  const totalVendidoMes = ventasMes.reduce((a,v)=>a+v.total,0);
  const gananciaMes     = ventasMes.reduce((a,v)=>a+v.ganancia,0);
  const totalGastosMes  = gastosMes.reduce((a,g)=>a+g.monto,0);
  const gananciaNetaMes = gananciaMes - totalGastosMes;

  const ganEfectivoMes    = ventasMes.filter(v=>v.metodoPago!=='transferencia').reduce((a,v)=>a+v.ganancia,0);
  const ganTransfMes      = ventasMes.filter(v=>v.metodoPago==='transferencia').reduce((a,v)=>a+v.ganancia,0);
  const gastosEfectivoMes = gastosMes.filter(g=>g.metodoPago!=='transferencia').reduce((a,g)=>a+g.monto,0);
  const gastosTransfMes   = gastosMes.filter(g=>g.metodoPago==='transferencia').reduce((a,g)=>a+g.monto,0);
  const netoEfectivo      = ganEfectivoMes - gastosEfectivoMes;
  const netoTransferencia = ganTransfMes - gastosTransfMes;

  const pagosProveedoresMes = DB.proveedores.flatMap(p => p.abonos||[])
    .filter(a => { const d = parseFechaCO(a.fecha); return d>=inicioMes && d<=finMes; })
    .reduce((s,a)=>s+a.monto,0);
  const ventasNetasMes = totalVendidoMes - pagosProveedoresMes;

  document.getElementById('resumen-neto-metrics').innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">
      <div class="metric dorado"><div class="mlabel">Ganancia del mes</div><div class="mvalue">${fmt(gananciaMes)}</div></div>
      <div class="metric danger"><div class="mlabel">Gastos del mes</div><div class="mvalue">${fmt(totalGastosMes)}</div></div>
      <div class="metric dorado"><div class="mlabel">Ganancia neta del mes</div><div class="mvalue">${fmt(gananciaNetaMes)}</div></div>
      <div class="metric"><div class="mlabel">Ventas del mes</div><div class="mvalue">${fmt(totalVendidoMes)}</div></div>
      <div class="metric danger"><div class="mlabel">Pagos a proveedores (mes)</div><div class="mvalue">${fmt(pagosProveedoresMes)}</div></div>
      <div class="metric"><div class="mlabel">Ventas netas del mes</div><div class="mvalue">${fmt(ventasNetasMes)}</div></div>
    </div>`;

  document.getElementById('resumen-neto-pago').innerHTML = `
    <div class="reporte-pago-card">
      <span class="rp-icon">💵</span>
      <div class="rp-label">Neto en Efectivo</div>
      <div class="rp-value">${fmt(netoEfectivo)}</div>
      <div class="rp-sub">Ganancia ${fmt(ganEfectivoMes)} − Gastos ${fmt(gastosEfectivoMes)}</div>
    </div>
    <div class="reporte-pago-card">
      <span class="rp-icon">🏦</span>
      <div class="rp-label">Neto en Transferencia</div>
      <div class="rp-value">${fmt(netoTransferencia)}</div>
      <div class="rp-sub">Ganancia ${fmt(ganTransfMes)} − Gastos ${fmt(gastosTransfMes)}</div>
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
  document.querySelectorAll('.gasto-cat-btn').forEach(b =>
    b.addEventListener('click', () => seleccionarCategoriaGasto(b.dataset.cat, b)));

  // Nota crédito

  // Historial
  document.getElementById('hist-fecha').addEventListener('change', renderHistorial);

  // Reportes
  document.querySelectorAll('.btn-reporte').forEach(b=>
    b.addEventListener('click',()=> renderReportes(b.dataset.periodo)));

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