// ---------------------------------------------------------------------
// 1. CONFIGURACIÓN GENERAL Y SEGURIDAD
// ---------------------------------------------------------------------
const SUPABASE_URL = 'https://irdjwuavnxigtcchrgeq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_DipKudFI5KaHLFEzTy_LbA_LHimXyF1';
const TELEGRAM_INVITE_URL = 'https://t.me/+jZ0C3NUO3ANmZDRh';

const MINUTOS_TIMEOUT_OFFLINE = 12;
const MINUTOS_INACTIVIDAD_LOGOUT = 30;

const _supabase = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let vistaActual = 'general';
let heladeraSeleccionada = '1';
let miniCharts = {};
let chartIndividualInstance = null;
let ultimosRegistrosGlobales = [];
let intervaloPolling = null;
let timerInactividad = null;
let qrGenerado = false;

let rangosPorHeladera = {};

// Sanitización estricta contra inyección XSS al renderizar textos de BD
function escapeHTML(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------
// 1B. AUTENTICACIÓN Y SESIÓN (SUPABASE AUTH + AUTO-LOGOUT)
// ---------------------------------------------------------------------
async function exigirSesionActiva() {
  const { data: { session }, error } = await _supabase.auth.getSession();
  if (error || !session) {
    await cerrarSesion(true);
    return false;
  }
  return true;
}

function reiniciarRelojInactividad() {
  if (timerInactividad) clearTimeout(timerInactividad);
  timerInactividad = setTimeout(() => {
    cerrarSesion(true);
  }, MINUTOS_INACTIVIDAD_LOGOUT * 60 * 1000);
}

['click', 'keydown', 'mousemove', 'touchstart'].forEach(evt => {
  document.addEventListener(evt, reiniciarRelojInactividad, { passive: true });
});

async function verificarSesionInicial() {
  const { data: { session } } = await _supabase.auth.getSession();
  const overlay = document.getElementById('loginOverlay');

  if (session) {
    overlay.style.display = 'none';
    reiniciarRelojInactividad();
    iniciarSistemaMonitoreo();
  } else {
    overlay.style.display = 'flex';
  }
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const btn = document.getElementById('btnLoginSubmit');
  const fb = document.getElementById('loginFeedback');

  fb.style.display = 'none';
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verificando...';

  const { error } = await _supabase.auth.signInWithPassword({ email, password });

  btn.disabled = false;
  btn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Ingresar al Sistema';

  if (error) {
    fb.innerText = 'Usuario o contraseña incorrectos.';
    fb.style.display = 'block';
  } else {
    document.getElementById('loginPassword').value = '';
    document.getElementById('loginOverlay').style.display = 'none';
    reiniciarRelojInactividad();
    iniciarSistemaMonitoreo();
  }
});

async function cerrarSesion(silencioso = false) {
  if (intervaloPolling) clearInterval(intervaloPolling);
  if (timerInactividad) clearTimeout(timerInactividad);
  detenerTonoAlarma();
  await _supabase.auth.signOut();
  if (silencioso) {
    document.getElementById('loginOverlay').style.display = 'flex';
  } else {
    location.reload();
  }
}

function iniciarSistemaMonitoreo() {
  actualizarBotonAudioUI();
  obtenerDatos();
  if (!intervaloPolling) {
    intervaloPolling = setInterval(obtenerDatos, 10000);
  }
}

// ---------------------------------------------------------------------
// UTILIDADES DE RANGOS Y TEMPERATURAS
// ---------------------------------------------------------------------
function obtenerRangoEquipo(id) {
  const key = String(id).trim();
  return rangosPorHeladera[key] || { 
    hMin: 2.0, 
    hMax: 8.0, 
    fMin: null, 
    fMax: -10.0, 
    invertidos: false,
    fechaReinicio: null
  };
}

function extraerTemperaturasReales(registro, rango) {
  const rawSensor1 = registro.temp_heladera !== null ? parseFloat(registro.temp_heladera) : null;
  const rawSensor2 = registro.temp_freezer !== null ? parseFloat(registro.temp_freezer) : null;

  if (rango.invertidos) {
    return {
      tempH: rawSensor2,
      tempF: rawSensor1,
      sensorH: 'Sensor 2',
      sensorF: 'Sensor 1'
    };
  } else {
    return {
      tempH: rawSensor1,
      tempF: rawSensor2,
      sensorH: 'Sensor 1',
      sensorF: 'Sensor 2'
    };
  }
}

function formatearTextoFreezer(rango) {
  return rango.fMin !== null 
    ? `${rango.fMin}°C a ${rango.fMax}°C` 
    : `≤ ${rango.fMax}°C (sin mín.)`;
}

function calcularMinutosTranscurridos(fechaISO) {
  const diffMs = Date.now() - new Date(fechaISO).getTime();
  return Math.floor(diffMs / 60000);
}

// ---------------------------------------------------------------------
// 2. SISTEMA DE AUDIO (Activar / Desactivar / Silenciar 15 min)
// ---------------------------------------------------------------------
let audioCtx = null;
let osc = null;
let gainNode = null;
let alarmaHabilitada = localStorage.getItem('hospital_alarma_activa') !== 'false';
let silenciadoHasta = 0;
let alarmaSonando = false;
let hayEmergenciaActiva = false;

function actualizarBotonAudioUI() {
  const btn = document.getElementById('btnAudio');
  const ahora = Date.now();

  if (!alarmaHabilitada) {
    btn.innerHTML = `<i class="fa-solid fa-volume-xmark"></i> Alarma: DESACTIVADA`;
    btn.className = "nav-btn btn-audio-off";
  } else if (silenciadoHasta > ahora) {
    const minsRestantes = Math.ceil((silenciadoHasta - ahora) / 60000);
    btn.innerHTML = `<i class="fa-solid fa-bell-slash"></i> Silenciada (${minsRestantes}m)`;
    btn.className = "nav-btn btn-audio-snoozed";
  } else {
    btn.innerHTML = `<i class="fa-solid fa-volume-high"></i> Alarma: ACTIVADA`;
    btn.className = "nav-btn btn-audio-on";
  }
}

function desbloquearAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

document.addEventListener('click', desbloquearAudioContext, { once: true });

function toggleAlarmaSonora() {
  desbloquearAudioContext();
  if (!alarmaHabilitada || silenciadoHasta > Date.now()) {
    alarmaHabilitada = true;
    silenciadoHasta = 0;
    localStorage.setItem('hospital_alarma_activa', 'true');
    actualizarBotonAudioUI();
    if (hayEmergenciaActiva) iniciarTonoAlarma();
  } else {
    alarmaHabilitada = false;
    silenciadoHasta = 0;
    localStorage.setItem('hospital_alarma_activa', 'false');
    detenerTonoAlarma();
    actualizarBotonAudioUI();
  }
}

function silenciarTemporalmente(minutos) {
  silenciadoHasta = Date.now() + (minutos * 60 * 1000);
  detenerTonoAlarma();
  actualizarBotonAudioUI();
}

function desactivarAlarmaDesdeBanner() {
  alarmaHabilitada = false;
  silenciadoHasta = 0;
  localStorage.setItem('hospital_alarma_activa', 'false');
  detenerTonoAlarma();
  actualizarBotonAudioUI();
}

function iniciarTonoAlarma() {
  if (!alarmaHabilitada || Date.now() < silenciadoHasta) {
    detenerTonoAlarma();
    return;
  }
  if (alarmaSonando) return;

  try {
    desbloquearAudioContext();
    osc = audioCtx.createOscillator();
    gainNode = audioCtx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(850, audioCtx.currentTime); 
    gainNode.gain.setValueAtTime(0.8, audioCtx.currentTime);

    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    osc.start();
    alarmaSonando = true;
  } catch (e) {
    console.warn('Esperando interacción para reproducir audio:', e);
  }
}

function detenerTonoAlarma() {
  if (osc && alarmaSonando) {
    try {
      osc.stop();
      osc.disconnect();
    } catch (e) {}
    alarmaSonando = false;
  }
}

// ---------------------------------------------------------------------
// 3. GESTIÓN DE RANGOS, SENSORES, CORREOS, QR TELEGRAM Y HARDWARE
// ---------------------------------------------------------------------
function renderizarQRTelegram() {
  if (qrGenerado) return;
  const contenedor = document.getElementById('telegramQrContainer');
  if (!contenedor || typeof QRCode === 'undefined') return;

  contenedor.innerHTML = '';
  new QRCode(contenedor, {
    text: TELEGRAM_INVITE_URL,
    width: 112,
    height: 112,
    colorDark: '#0F172A',
    colorLight: '#FFFFFF',
    correctLevel: QRCode.CorrectLevel.M
  });
  qrGenerado = true;
}

function descargarQRTelegram() {
  const contenedor = document.getElementById('telegramQrContainer');
  const canvas = contenedor.querySelector('canvas');
  const img = contenedor.querySelector('img');
  const dataUrl = canvas ? canvas.toDataURL('image/png') : (img ? img.src : null);

  if (!dataUrl) return;
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = 'QR_Grupo_Alertas_Telegram_HMyN.png';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

async function cargarRangosConfigurados() {
  const errorDiv = document.getElementById('errorConsole');
  const { data, error } = await _supabase
    .from('configuracion_rangos')
    .select('*')
    .order('heladera_id', { ascending: true });

  if (error) {
    console.error('Error leyendo configuracion_rangos:', error);
    errorDiv.innerText = `Error al leer configuración: ${error.message}`;
    return;
  }

  if (data && data.length > 0) {
    data.forEach(row => {
      const key = String(row.heladera_id).trim();
      rangosPorHeladera[key] = {
        hMin: parseFloat(row.heladera_min),
        hMax: parseFloat(row.heladera_max),
        fMin: row.freezer_min !== null ? parseFloat(row.freezer_min) : null,
        fMax: parseFloat(row.freezer_max),
        invertidos: Boolean(row.sensores_invertidos),
        fechaReinicio: row.fecha_reinicio_graficas ? new Date(row.fecha_reinicio_graficas) : null
      };
    });
  }
}

async function abrirModalRangos() {
  if (!(await exigirSesionActiva())) return;
  document.getElementById('modalRangos').style.display = 'flex';
  ocultarFeedback('modalFeedback');
  actualizarSelectoresEquipos();
  precargarValoresModal();
  renderizarQRTelegram();
  cargarDestinatarios();
  cargarHistorialCambios();
}

function cerrarModalRangos() {
  document.getElementById('modalRangos').style.display = 'none';
}

async function abrirModalReinicio() {
  if (!(await exigirSesionActiva())) return;
  document.getElementById('modalReinicio').style.display = 'flex';
  ocultarFeedback('resetFeedback');
  actualizarSelectoresEquipos();
}

function cerrarModalReinicio() {
  document.getElementById('modalReinicio').style.display = 'none';
}

function toggleSelectHeladeraModal() {
  const modo = document.getElementById('modoAplicacion').value;
  document.getElementById('grupoHeladeraModal').style.display = (modo === 'INDIVIDUAL') ? 'block' : 'none';
}

function toggleSelectHeladeraReinicio() {
  const alcance = document.getElementById('alcanceReinicio').value;
  document.getElementById('grupoHeladeraReinicio').style.display = (alcance === 'INDIVIDUAL') ? 'block' : 'none';
}

function actualizarSelectoresEquipos() {
  const ids = Object.keys(rangosPorHeladera).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (ids.length === 0) return;

  const selectModal = document.getElementById('heladeraObjetivo');
  const selectReinicio = document.getElementById('heladeraReinicioObjetivo');
  const selectNav = document.getElementById('selectHeladeraNav');
  const selectLiberar = document.getElementById('heladeraLiberarObjetivo');
  const selectEliminar = document.getElementById('heladeraEliminarObjetivo');
  
  const prevModal = selectModal.value;
  const prevReinicio = selectReinicio.value;
  const prevNav = selectNav.value;
  const prevLiberar = selectLiberar ? selectLiberar.value : '';
  const prevEliminar = selectEliminar ? selectEliminar.value : '';

  selectModal.innerHTML = '';
  selectReinicio.innerHTML = '';
  selectNav.innerHTML = '';
  if (selectLiberar) selectLiberar.innerHTML = '';
  if (selectEliminar) selectEliminar.innerHTML = '';

  ids.forEach(id => {
    const safeId = escapeHTML(id);
    selectModal.innerHTML += `<option value="${safeId}">Heladera N° ${safeId}</option>`;
    selectReinicio.innerHTML += `<option value="${safeId}">Heladera N° ${safeId}</option>`;
    selectNav.innerHTML += `<option value="${safeId}">Heladera N° ${safeId}</option>`;
    if (selectLiberar) selectLiberar.innerHTML += `<option value="${safeId}">Heladera N° ${safeId}</option>`;
    if (selectEliminar) selectEliminar.innerHTML += `<option value="${safeId}">Heladera N° ${safeId}</option>`;
  });

  if (ids.includes(prevModal)) selectModal.value = prevModal;
  if (ids.includes(prevReinicio)) selectReinicio.value = prevReinicio;
  if (selectLiberar && ids.includes(prevLiberar)) selectLiberar.value = prevLiberar;
  if (selectEliminar && ids.includes(prevEliminar)) selectEliminar.value = prevEliminar;
  if (ids.includes(prevNav)) {
    selectNav.value = prevNav;
  } else {
    heladeraSeleccionada = ids[0];
    selectNav.value = ids[0];
  }
}

function precargarValoresModal() {
  const id = document.getElementById('heladeraObjetivo').value;
  const r = obtenerRangoEquipo(id);
  document.getElementById('inputHMin').value = r.hMin;
  document.getElementById('inputHMax').value = r.hMax;
  document.getElementById('inputFMin').value = r.fMin !== null ? r.fMin : '';
  document.getElementById('inputFMax').value = r.fMax;
  document.getElementById('selectAsignacionSensores').value = r.invertidos ? 'true' : 'false';
}

function mostrarFeedback(elementId, mensaje, esError) {
  const fb = document.getElementById(elementId);
  fb.innerText = mensaje;
  fb.className = `modal-feedback ${esError ? 'feedback-error' : 'feedback-ok'}`;
  fb.style.display = 'block';
}

function ocultarFeedback(elementId) {
  document.getElementById(elementId).style.display = 'none';
}

// --- Gestión de Destinatarios de Alertas (Solo Email) ---
async function cargarDestinatarios() {
  const lista = document.getElementById('listaDestinatarios');
  const { data, error } = await _supabase
    .from('destinatarios_alertas')
    .select('*')
    .eq('tipo', 'email')
    .order('id', { ascending: true });

  if (error) {
    lista.innerHTML = `<li style="color:#B91C1C; font-size:0.8em;">Error cargando correos: ${escapeHTML(error.message)}</li>`;
    return;
  }

  if (!data || data.length === 0) {
    lista.innerHTML = '<li style="font-size:0.8em; color:var(--text-muted); text-align:center;">No hay correos cargados aún.</li>';
    return;
  }

  lista.innerHTML = data.map(d => {
    const safeId = Number(d.id);
    return `
      <li class="dest-item">
        <div class="dest-item-info">
          <span class="dest-tag-email"><i class="fa-solid fa-envelope"></i> Email</span>
          <strong>${escapeHTML(d.nombre)}</strong>
          <span style="color:var(--text-muted);">(${escapeHTML(d.destino)})</span>
        </div>
        <button type="button" class="btn-del-dest" onclick="eliminarDestinatario(${safeId})">
          <i class="fa-solid fa-trash"></i>
        </button>
      </li>
    `;
  }).join('');
}

async function agregarDestinatario() {
  if (!(await exigirSesionActiva())) return;

  const nombre = document.getElementById('destNombre').value.trim();
  const destino = document.getElementById('destValor').value.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!nombre || !destino) {
    mostrarFeedback('modalFeedback', 'Completá el nombre/sector y el correo electrónico.', true);
    return;
  }

  if (!emailRegex.test(destino)) {
    mostrarFeedback('modalFeedback', 'Ingresá una dirección de correo electrónico válida.', true);
    return;
  }

  const { error } = await _supabase
    .from('destinatarios_alertas')
    .insert([{ nombre, tipo: 'email', destino }]);

  if (error) {
    mostrarFeedback('modalFeedback', `Error al agregar correo: ${error.message}`, true);
    return;
  }

  document.getElementById('destNombre').value = '';
  document.getElementById('destValor').value = '';
  ocultarFeedback('modalFeedback');
  cargarDestinatarios();
}

async function eliminarDestinatario(id) {
  if (!(await exigirSesionActiva())) return;

  const { error } = await _supabase
    .from('destinatarios_alertas')
    .delete()
    .eq('id', Number(id));

  if (!error) cargarDestinatarios();
}

// --- Reemplazo de ESP32 Dañado (Liberar MAC conservando historial) ---
async function liberarPlacaESP32() {
  if (!(await exigirSesionActiva())) return;

  const idRaw = document.getElementById('heladeraLiberarObjetivo').value;
  const idObj = isNaN(Number(idRaw)) ? idRaw : Number(idRaw);

  const ok = confirm(
    `¿Confirmás dar de baja el ESP32 físico vinculado a la Heladera N° ${idRaw}?\n\n` +
    `La placa anterior quedará desvinculada y el próximo ESP32 que configures con el N° ${idRaw} tomará su lugar conservando todos los rangos e historiales.`
  );
  if (!ok) return;

  const { error } = await _supabase
    .from('configuracion_rangos')
    .update({ mac_esp32: null })
    .eq('heladera_id', idObj);

  if (error) {
    mostrarFeedback('modalFeedback', `Error al liberar placa: ${error.message}`, true);
    return;
  }

  mostrarFeedback('modalFeedback', `Heladera N° ${idRaw} liberada. Ya podés configurar el nuevo ESP32 con ese número.`, false);
}

// --- Baja Definitiva de Equipo (Con doble confirmación) ---
async function eliminarEquipoRegistrado() {
  if (!(await exigirSesionActiva())) return;

  const idRaw = document.getElementById('heladeraEliminarObjetivo').value;
  const idObj = isNaN(Number(idRaw)) ? idRaw : Number(idRaw);

  const paso1 = confirm(
    `⚠️ ATENCIÓN: Vas a dar de baja definitivamente la Heladera N° ${idRaw}.\n\n` +
    `Se eliminará su configuración, sus rangos y todas sus lecturas de temperatura en la base de datos.\n` +
    `¿Deseás continuar?`
  );
  if (!paso1) return;

  const textoConfirmacion = prompt(
    `Para confirmar la eliminación definitiva de la Heladera N° ${idRaw}, escribí la palabra ELIMINAR en mayúsculas:`
  );
  if (textoConfirmacion !== 'ELIMINAR') {
    mostrarFeedback('modalFeedback', 'Eliminación cancelada: no se escribió la palabra de confirmación.', true);
    return;
  }

  const { error: errMed } = await _supabase
    .from('mediciones_temperatura')
    .delete()
    .eq('heladera_id', idObj);

  if (errMed) {
    mostrarFeedback('modalFeedback', `Error al borrar mediciones: ${errMed.message}`, true);
    return;
  }

  const { error: errConf } = await _supabase
    .from('configuracion_rangos')
    .delete()
    .eq('heladera_id', idObj);

  if (errConf) {
    mostrarFeedback('modalFeedback', `Error al eliminar equipo: ${errConf.message}`, true);
    return;
  }

  delete rangosPorHeladera[String(idRaw)];
  const cardDOM = document.getElementById(`card-general-${idRaw}`);
  if (cardDOM) cardDOM.remove();

  mostrarFeedback('modalFeedback', `Heladera N° ${idRaw} eliminada correctamente del sistema.`, false);
  actualizarSelectoresEquipos();
  obtenerDatos();
}

// --- Reinicio de Gráficas ---
async function ejecutarReinicioGraficas() {
  if (!(await exigirSesionActiva())) return;

  const alcance = document.getElementById('alcanceReinicio').value;
  const ahoraISO = new Date().toISOString();

  if (alcance === 'INDIVIDUAL') {
    const idRaw = document.getElementById('heladeraReinicioObjetivo').value;
    const idObj = isNaN(Number(idRaw)) ? idRaw : Number(idRaw);

    const { error } = await _supabase
      .from('configuracion_rangos')
      .update({ fecha_reinicio_graficas: ahoraISO })
      .eq('heladera_id', idObj);

    if (error) {
      mostrarFeedback('resetFeedback', `Error al reiniciar: ${error.message}`, true);
      return;
    }
  } else {
    const ids = Object.keys(rangosPorHeladera).map(id => isNaN(Number(id)) ? id : Number(id));
    const { error } = await _supabase
      .from('configuracion_rangos')
      .update({ fecha_reinicio_graficas: ahoraISO })
      .in('heladera_id', ids);

    if (error) {
      mostrarFeedback('resetFeedback', `Error al reiniciar gráficas: ${error.message}`, true);
      return;
    }
  }

  mostrarFeedback('resetFeedback', 'Gráficas reiniciadas. Esperando nuevas lecturas...', false);

  await cargarRangosConfigurados();
  obtenerDatos();

  setTimeout(() => {
    cerrarModalReinicio();
  }, 1500);
}

// --- Guardar Nuevos Rangos ---
async function guardarNuevosRangos() {
  if (!(await exigirSesionActiva())) return;

  const modo = document.getElementById('modoAplicacion').value;
  const invertidos = document.getElementById('selectAsignacionSensores').value === 'true';
  const hMin = parseFloat(document.getElementById('inputHMin').value);
  const hMax = parseFloat(document.getElementById('inputHMax').value);
  
  const fMinRaw = document.getElementById('inputFMin').value.trim();
  const fMin = fMinRaw === '' ? null : parseFloat(fMinRaw);
  const fMax = parseFloat(document.getElementById('inputFMax').value);

  if (isNaN(hMin) || isNaN(hMax) || isNaN(fMax) || (fMin !== null && isNaN(fMin))) {
    mostrarFeedback('modalFeedback', 'Los valores ingresados deben ser numéricos válidos.', true);
    return;
  }

  if (hMin >= hMax || (fMin !== null && fMin >= fMax)) {
    mostrarFeedback('modalFeedback', 'La temperatura mínima debe ser menor que la máxima.', true);
    return;
  }

  const ahoraISO = new Date().toISOString();
  let heladeraIdLog = null;

  if (modo === 'INDIVIDUAL') {
    const idRaw = document.getElementById('heladeraObjetivo').value;
    const idObj = isNaN(Number(idRaw)) ? idRaw : Number(idRaw);
    heladeraIdLog = idObj;

    const { error } = await _supabase
      .from('configuracion_rangos')
      .upsert({
        heladera_id: idObj,
        heladera_min: hMin,
        heladera_max: hMax,
        freezer_min: fMin,
        freezer_max: fMax,
        sensores_invertidos: invertidos,
        ultima_actualizacion: ahoraISO
      });

    if (error) {
      mostrarFeedback('modalFeedback', `Error al actualizar equipo: ${error.message}`, true);
      return;
    }
  } else {
    const ids = Object.keys(rangosPorHeladera).map(id => isNaN(Number(id)) ? id : Number(id));
    const filasUpsert = ids.map(id => ({
      heladera_id: id,
      heladera_min: hMin,
      heladera_max: hMax,
      freezer_min: fMin,
      freezer_max: fMax,
      sensores_invertidos: invertidos,
      ultima_actualizacion: ahoraISO
    }));

    const { error } = await _supabase
      .from('configuracion_rangos')
      .upsert(filasUpsert);

    if (error) {
      mostrarFeedback('modalFeedback', `Error en actualización masiva: ${error.message}`, true);
      return;
    }
  }

  await _supabase
    .from('historial_cambios_rangos')
    .insert({
      fecha_cambio: ahoraISO,
      tipo_aplicacion: modo,
      heladera_id: heladeraIdLog,
      heladera_min: hMin,
      heladera_max: hMax,
      freezer_min: fMin,
      freezer_max: fMax,
      sensores_invertidos: invertidos
    });

  mostrarFeedback('modalFeedback', 'Configuración guardada correctamente.', false);
  
  await cargarRangosConfigurados();
  await cargarHistorialCambios();
  obtenerDatos();
}

async function cargarHistorialCambios() {
  const tbody = document.getElementById('tablaHistorialBody');
  const { data, error } = await _supabase
    .from('historial_cambios_rangos')
    .select('*')
    .order('fecha_cambio', { ascending: false })
    .limit(8);

  if (error || !data || data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Sin modificaciones registradas aún.</td></tr>';
    return;
  }

  tbody.innerHTML = data.map(row => {
    const fecha = new Date(row.fecha_cambio).toLocaleString('es-AR', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    const alcance = row.tipo_aplicacion === 'GENERAL' 
      ? '<strong>Todas</strong>' 
      : `N° ${escapeHTML(row.heladera_id)}`;
    const textoSensores = row.sensores_invertidos 
      ? 'S1:Freez / S2:Hel' 
      : 'S1:Hel / S2:Freez';
    const textoFreezer = row.freezer_min !== null 
      ? `${Number(row.freezer_min)}° a ${Number(row.freezer_max)}°` 
      : `≤ ${Number(row.freezer_max)}°`;
    return `
      <tr>
        <td>${escapeHTML(fecha)}</td>
        <td>${alcance}</td>
        <td>${textoSensores}</td>
        <td>${Number(row.heladera_min)}° a ${Number(row.heladera_max)}°</td>
        <td>${textoFreezer}</td>
      </tr>
    `;
  }).join('');
}

// ---------------------------------------------------------------------
// 4. EXPORTAR REPORTE CSV
// ---------------------------------------------------------------------
async function exportarCSV() {
  if (!(await exigirSesionActiva())) return;

  if (!ultimosRegistrosGlobales || ultimosRegistrosGlobales.length === 0) {
    alert('No hay datos disponibles para exportar.');
    return;
  }

  let csv = 'Fecha y Hora;Equipo;Temp Heladera (C);Temp Freezer (C);Estado\n';

  ultimosRegistrosGlobales.forEach(row => {
    const id = String(row.heladera_id).trim();
    const rango = obtenerRangoEquipo(id);
    const { tempH, tempF } = extraerTemperaturasReales(row, rango);
    const fechaStr = new Date(row.fecha_hora).toLocaleString('es-AR');

    const hCrit = tempH !== null && (tempH < rango.hMin || tempH > rango.hMax);
    const fCrit = tempF !== null && (tempF > rango.fMax || (rango.fMin !== null && tempF < rango.fMin));
    const estado = (hCrit || fCrit) ? 'ALERTA CRITICA' : 'NORMAL';

    const valH = tempH !== null ? tempH.toFixed(1).replace('.', ',') : '';
    const valF = tempF !== null ? tempF.toFixed(1).replace('.', ',') : '';

    csv += `${fechaStr};Heladera N° ${id};${valH};${valF};${estado}\n`;
  });

  const blob = new Blob(["\uFEFF" + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const fechaHoy = new Date().toISOString().slice(0, 10);
  link.setAttribute('href', url);
  link.setAttribute('download', `Reporte_Temperaturas_Hospital_${fechaHoy}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------
// 5. CAMBIO DE VISTAS Y NAVEGACIÓN DIRECTA POR TARJETA
// ---------------------------------------------------------------------
function setVista(modo) {
  vistaActual = modo;
  const btnG = document.getElementById('btnViewGeneral');
  const btnI = document.getElementById('btnViewSingle');
  const selectNav = document.getElementById('selectHeladeraNav');

  if (modo === 'general') {
    btnG.classList.add('active');
    btnI.classList.remove('active');
    selectNav.style.display = 'none';
    document.getElementById('vistaGeneral').style.display = 'grid';
    document.getElementById('vistaIndividual').style.display = 'none';
  } else {
    btnI.classList.add('active');
    btnG.classList.remove('active');
    selectNav.style.display = 'inline-block';
    document.getElementById('vistaGeneral').style.display = 'none';
    document.getElementById('vistaIndividual').style.display = 'flex';
    inicializarGraficoIndividual();
  }
  obtenerDatos();
}

function cambiarHeladeraIndividual() {
  heladeraSeleccionada = String(document.getElementById('selectHeladeraNav').value).trim();
  obtenerDatos();
}

function abrirDetalleHeladera(id) {
  heladeraSeleccionada = String(id).trim();
  const selectNav = document.getElementById('selectHeladeraNav');
  if (selectNav) {
    selectNav.value = heladeraSeleccionada;
  }
  setVista('individual');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------------------------------------------------------------------
// 6. LÓGICA PRINCIPAL DE DATOS
// ---------------------------------------------------------------------
async function obtenerDatos() {
  if (!(await exigirSesionActiva())) return;

  const errorDiv = document.getElementById('errorConsole');
  errorDiv.innerText = '';
  actualizarBotonAudioUI();

  await cargarRangosConfigurados();

  const { data, error } = await _supabase
    .from('mediciones_temperatura')
    .select('*')
    .order('fecha_hora', { ascending: false })
    .limit(300);

  if (error) {
    console.error('Error Supabase:', error);
    errorDiv.innerText = `Error al consultar datos: ${error.message}`;
    return;
  }

  if (!data || data.length === 0) {
    errorDiv.innerText = 'No hay registros guardados en la base de datos.';
    return;
  }

  ultimosRegistrosGlobales = data;

  const medicionesPorHeladera = {};
  Object.keys(rangosPorHeladera).forEach(id => {
    medicionesPorHeladera[id] = [];
  });

  data.forEach(row => {
    const id = String(row.heladera_id).trim();
    if (!medicionesPorHeladera[id]) {
      medicionesPorHeladera[id] = [];
      if (!rangosPorHeladera[id]) {
        rangosPorHeladera[id] = { hMin: 2.0, hMax: 8.0, fMin: null, fMax: -10.0, invertidos: false, fechaReinicio: null };
      }
    }

    const rango = obtenerRangoEquipo(id);
    const fechaMedicion = new Date(row.fecha_hora);
    if (!rango.fechaReinicio || fechaMedicion >= rango.fechaReinicio) {
      medicionesPorHeladera[id].push(row);
    }
  });

  actualizarSelectoresEquipos();
  evaluarEmergencias(medicionesPorHeladera);

  if (vistaActual === 'general') {
    renderizarVistaGeneral(medicionesPorHeladera);
  } else {
    renderizarVistaIndividual(medicionesPorHeladera[heladeraSeleccionada] || [], heladeraSeleccionada);
  }

  document.getElementById('lastUpdate').innerText = `Última sincronización global: ${new Date().toLocaleTimeString('es-AR')}`;
}

// ---------------------------------------------------------------------
// 7. BANNER SUPERIOR DE EMERGENCIAS (CRÍTICO + SIN SEÑAL SIMULTÁNEO)
// ---------------------------------------------------------------------
function evaluarEmergencias(medicionesPorHeladera) {
  const banner = document.getElementById('emergencyBanner');
  const grid = document.getElementById('emergencyCardsGrid');
  grid.innerHTML = '';
  
  hayEmergenciaActiva = false;

  Object.keys(medicionesPorHeladera).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).forEach(id => {
    const registros = medicionesPorHeladera[id];
    if (!registros || registros.length === 0) return;

    const safeId = escapeHTML(id);
    const ultimo = registros[0];
    const rango = obtenerRangoEquipo(id);
    const { tempH, tempF, sensorH, sensorF } = extraerTemperaturasReales(ultimo, rango);
    const minsSinDatos = calcularMinutosTranscurridos(ultimo.fecha_hora);
    const estaOffline = minsSinDatos > MINUTOS_TIMEOUT_OFFLINE;

    const hCritica = tempH !== null && (tempH < rango.hMin || tempH > rango.hMax);
    const fCritica = tempF !== null && (
      tempF > rango.fMax || (rango.fMin !== null && tempF < rango.fMin)
    );

    if (hCritica || fCritica) {
      hayEmergenciaActiva = true;
      grid.innerHTML += `
        <div class="heladera-card in-alert" onclick="abrirDetalleHeladera('${safeId}')" title="Ver gráfico detallado de Heladera N° ${safeId}">
          <div class="card-header">
            <span class="card-title" style="color: var(--alert-red)"><i class="fa-solid fa-box-archive"></i> Heladera N° ${safeId}</span>
            <div style="display:flex; gap:5px; flex-wrap:wrap; justify-content:flex-end;">
              <span class="card-badge badge-alert"><i class="fa-solid fa-triangle-exclamation"></i> CRÍTICO</span>
              ${estaOffline ? `<span class="card-badge badge-offline"><i class="fa-solid fa-wifi"></i> SIN SEÑAL (${minsSinDatos}m)</span>` : ''}
            </div>
          </div>
          <div style="font-size: 0.9em; line-height: 1.5; color: #7F1D1D; font-weight:600;">
            ${hCritica ? `<div><i class="fa-solid fa-temperature-high"></i> Heladera (${sensorH}): <strong style="color:var(--alert-red); font-size:1.1em;">${tempH.toFixed(1)} °C</strong> <span style="font-size:0.8em;">(${rango.hMin}° a ${rango.hMax}°)</span></div>` : ''}
            ${fCritica ? `<div><i class="fa-solid fa-snowflake"></i> Freezer (${sensorF}): <strong style="color:var(--alert-red); font-size:1.1em;">${tempF.toFixed(1)} °C</strong> <span style="font-size:0.8em;">(${formatearTextoFreezer(rango)})</span></div>` : ''}
          </div>
        </div>
      `;
    }
  });

  if (hayEmergenciaActiva) {
    banner.style.display = 'block';
    iniciarTonoAlarma();
  } else {
    banner.style.display = 'none';
    detenerTonoAlarma();
  }
}

// ---------------------------------------------------------------------
// 8. RENDERIZADO DE VISTA GENERAL
// ---------------------------------------------------------------------
function renderizarVistaGeneral(medicionesPorHeladera) {
  const container = document.getElementById('vistaGeneral');
  
  Object.keys(medicionesPorHeladera).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).forEach(id => {
    const safeId = escapeHTML(id);
    let card = document.getElementById(`card-general-${id}`);
    if (!card) {
      card = document.createElement('div');
      card.id = `card-general-${id}`;
      card.className = 'heladera-card';
      container.appendChild(card);
    }

    card.onclick = () => abrirDetalleHeladera(id);
    card.title = `Hacé clic para ver el gráfico detallado de Heladera N° ${safeId}`;

    const rango = obtenerRangoEquipo(id);
    const registros = (medicionesPorHeladera[id] || []).slice(0, 12).reverse();
    const textoReinicio = rango.fechaReinicio 
      ? `<span><i class="fa-solid fa-clock"></i> Inicio: ${rango.fechaReinicio.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>` 
      : '<span></span>';

    if (registros.length === 0) {
      if (miniCharts[id]) {
        miniCharts[id].destroy();
        delete miniCharts[id];
      }
      card.className = 'heladera-card';
      card.innerHTML = `
        <div class="card-header">
          <span class="card-title"><i class="fa-solid fa-box-archive" style="color:var(--accent-teal);"></i> Heladera N° ${safeId}</span>
          <span class="card-badge badge-waiting"><i class="fa-solid fa-hourglass-half"></i> ESPERANDO</span>
        </div>
        <div class="card-body">
          <div class="card-temps">
            <div class="temp-item">
              <div class="temp-label">Heladera <span class="sensor-tag">${rango.invertidos ? 'Sensor 2' : 'Sensor 1'}</span></div>
              <div class="temp-val">-- °C</div>
              <div class="temp-range-hint">Límite: ${rango.hMin}°C a ${rango.hMax}°C</div>
            </div>
            <div class="temp-item">
              <div class="temp-label">Freezer <span class="sensor-tag">${rango.invertidos ? 'Sensor 1' : 'Sensor 2'}</span></div>
              <div class="temp-val">-- °C</div>
              <div class="temp-range-hint">Límite: ${formatearTextoFreezer(rango)}</div>
            </div>
          </div>
          <div class="card-chart-mini" style="text-align:center; font-size:0.75em; color:#64748B;">
            <i class="fa-solid fa-chart-line fa-2x" style="opacity:0.25; margin-bottom:6px;"></i>
            <div>Sin lecturas nuevas aún</div>
          </div>
        </div>
        <div class="card-footer-meta">${textoReinicio}<span>Esperando señal ESP32...</span></div>
      `;
      return;
    }

    const ultimo = registros[registros.length - 1];
    const { tempH, tempF, sensorH, sensorF } = extraerTemperaturasReales(ultimo, rango);
    const minsSinDatos = calcularMinutosTranscurridos(ultimo.fecha_hora);
    const estaOffline = minsSinDatos > MINUTOS_TIMEOUT_OFFLINE;

    const hCritica = tempH !== null && (tempH < rango.hMin || tempH > rango.hMax);
    const fCritica = tempF !== null && (
      tempF > rango.fMax || (rango.fMin !== null && tempF < rango.fMin)
    );
    const enAlerta = hCritica || fCritica;

    let cardClase = 'heladera-card';
    let badgeHTML = '<span class="card-badge badge-ok"><i class="fa-solid fa-circle-check"></i> NORMAL</span>';

    if (enAlerta && estaOffline) {
      cardClase = 'heladera-card in-alert';
      badgeHTML = `
        <div style="display:flex; gap:5px; flex-wrap:wrap; justify-content:flex-end;">
          <span class="card-badge badge-alert"><i class="fa-solid fa-triangle-exclamation"></i> ALERTA</span>
          <span class="card-badge badge-offline"><i class="fa-solid fa-wifi"></i> SIN SEÑAL (${minsSinDatos}m)</span>
        </div>
      `;
    } else if (enAlerta) {
      cardClase = 'heladera-card in-alert';
      badgeHTML = '<span class="card-badge badge-alert"><i class="fa-solid fa-triangle-exclamation"></i> ALERTA</span>';
    } else if (estaOffline) {
      cardClase = 'heladera-card in-offline';
      badgeHTML = `<span class="card-badge badge-offline"><i class="fa-solid fa-wifi"></i> SIN SEÑAL (${minsSinDatos}m)</span>`;
    }

    const horaUltimoDato = new Date(ultimo.fecha_hora).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });

    card.className = cardClase;
    card.innerHTML = `
      <div class="card-header">
        <span class="card-title"><i class="fa-solid fa-box-archive" style="color:var(--accent-teal);"></i> Heladera N° ${safeId}</span>
        ${badgeHTML}
      </div>
      <div class="card-body">
        <div class="card-temps">
          <div class="temp-item">
            <div class="temp-label">
              <i class="fa-solid fa-temperature-three-quarters" style="color:var(--accent-teal);"></i> 
              Heladera <span class="sensor-tag">${sensorH}</span>
            </div>
            <div class="temp-val ${hCritica ? 'critical' : ''}">${tempH !== null ? tempH.toFixed(1) + ' °C' : '--'}</div>
            <div class="temp-range-hint">Límite: ${rango.hMin}°C a ${rango.hMax}°C</div>
          </div>
          <div class="temp-item">
            <div class="temp-label">
              <i class="fa-solid fa-snowflake" style="color:var(--text-muted);"></i> 
              Freezer <span class="sensor-tag">${sensorF}</span>
            </div>
            <div class="temp-val ${fCritica ? 'critical' : ''}">${tempF !== null ? tempF.toFixed(1) + ' °C' : '--'}</div>
            <div class="temp-range-hint">Límite: ${formatearTextoFreezer(rango)}</div>
          </div>
        </div>
        <div class="card-chart-mini">
          <canvas id="mini-chart-${safeId}"></canvas>
        </div>
      </div>
      <div class="card-footer-meta">
        ${textoReinicio}
        <span>Último reporte: <strong>${horaUltimoDato}</strong></span>
      </div>
    `;

    setTimeout(() => renderMiniChart(id, registros, rango), 50);
  });
}

function renderMiniChart(id, registros, rango) {
  const ctx = document.getElementById(`mini-chart-${id}`)?.getContext('2d');
  if (!ctx) return;

  const labels = registros.map(r => new Date(r.fecha_hora).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }));
  const dataH = registros.map(r => extraerTemperaturasReales(r, rango).tempH);
  const dataF = registros.map(r => extraerTemperaturasReales(r, rango).tempF);

  if (miniCharts[id]) {
    miniCharts[id].destroy();
  }

  miniCharts[id] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        { label: 'Heladera', data: dataH, borderColor: '#29A19C', borderWidth: 2.5, pointRadius: registros.length === 1 ? 3 : 0, tension: 0.3 },
        { label: 'Freezer', data: dataF, borderColor: '#64748B', borderWidth: 1.5, pointRadius: registros.length === 1 ? 3 : 0, tension: 0.3 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { display: false }, y: { display: false } }
    }
  });
}

// ---------------------------------------------------------------------
// 9. RENDERIZADO DE VISTA INDIVIDUAL DETALLADA
// ---------------------------------------------------------------------
function inicializarGraficoIndividual() {
  const ctx = document.getElementById('chartIndividual').getContext('2d');
  if (chartIndividualInstance) chartIndividualInstance.destroy();

  chartIndividualInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'Heladera (°C)', borderColor: '#29A19C', backgroundColor: 'rgba(41, 161, 156, 0.08)', data: [], borderWidth: 2.5, fill: true, tension: 0.3 },
        { label: 'Freezer (°C)', borderColor: '#64748B', backgroundColor: 'rgba(100, 116, 139, 0.04)', data: [], borderWidth: 2, fill: true, tension: 0.3 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: { display: true, text: `Histórico Detallado - Heladera N° ${heladeraSeleccionada}`, color: '#0F172A', font: { family: 'Inter', size: 15, weight: 700 } },
        legend: { labels: { color: '#0F172A', font: { family: 'Inter', weight: 600 } } }
      },
      scales: {
        x: { title: { display: true, text: 'Hora', color: '#64748B', font: { family: 'Inter' } }, ticks: { color: '#0F172A', font: { family: 'Inter' } }, grid: { color: '#E2E8F0' } },
        y: { title: { display: true, text: 'Temperatura (°C)', color: '#64748B', font: { family: 'Inter' } }, ticks: { color: '#0F172A', font: { family: 'Inter' } }, grid: { color: '#E2E8F0' } }
      }
    }
  });
}

function renderizarVistaIndividual(registros, id) {
  const rango = obtenerRangoEquipo(id);

  if (!registros || registros.length === 0) {
    document.getElementById('singleSensorTagH').innerText = rango.invertidos ? 'Sensor 2' : 'Sensor 1';
    document.getElementById('singleTempH').innerText = '-- °C';
    document.getElementById('singleRangeH').innerText = `Límite: ${rango.hMin}°C a ${rango.hMax}°C`;
    document.getElementById('singleStatusH').innerHTML = '<i class="fa-solid fa-hourglass-half"></i> ESPERANDO';
    document.getElementById('singleStatusH').className = 'card-badge badge-waiting';
    document.getElementById('singleCardH').className = 'metric-box';

    document.getElementById('singleSensorTagF').innerText = rango.invertidos ? 'Sensor 1' : 'Sensor 2';
    document.getElementById('singleTempF').innerText = '-- °C';
    document.getElementById('singleRangeF').innerText = `Límite: ${formatearTextoFreezer(rango)}`;
    document.getElementById('singleStatusF').innerHTML = '<i class="fa-solid fa-hourglass-half"></i> ESPERANDO';
    document.getElementById('singleStatusF').className = 'card-badge badge-waiting';
    document.getElementById('singleCardF').className = 'metric-box';

    if (chartIndividualInstance) {
      chartIndividualInstance.options.plugins.title.text = `Histórico Detallado - Heladera N° ${heladeraSeleccionada} (Esperando lecturas)`;
      chartIndividualInstance.data.labels = [];
      chartIndividualInstance.data.datasets[0].data = [];
      chartIndividualInstance.data.datasets[1].data = [];
      chartIndividualInstance.update();
    }
    return;
  }

  const ordenados = [...registros].slice(0, 20).reverse();
  const ultimo = ordenados[ordenados.length - 1];
  const { tempH, tempF, sensorH, sensorF } = extraerTemperaturasReales(ultimo, rango);

  const hCritica = tempH !== null && (tempH < rango.hMin || tempH > rango.hMax);
  const fCritica = tempF !== null && (
    tempF > rango.fMax || (rango.fMin !== null && tempF < rango.fMin)
  );

  document.getElementById('singleSensorTagH').innerText = sensorH;
  document.getElementById('singleTempH').innerText = tempH !== null ? `${tempH.toFixed(1)} °C` : '--';
  document.getElementById('singleRangeH').innerText = `Límite: ${rango.hMin}°C a ${rango.hMax}°C`;
  document.getElementById('singleStatusH').innerHTML = hCritica ? '<i class="fa-solid fa-triangle-exclamation"></i> CRÍTICO' : '<i class="fa-solid fa-check"></i> NORMAL';
  document.getElementById('singleStatusH').className = `card-badge ${hCritica ? 'badge-alert' : 'badge-ok'}`;
  document.getElementById('singleCardH').className = `metric-box ${hCritica ? 'alert-border' : ''}`;

  document.getElementById('singleSensorTagF').innerText = sensorF;
  document.getElementById('singleTempF').innerText = tempF !== null ? `${tempF.toFixed(1)} °C` : '--';
  document.getElementById('singleRangeF').innerText = `Límite: ${formatearTextoFreezer(rango)}`;
  document.getElementById('singleStatusF').innerHTML = fCritica ? '<i class="fa-solid fa-triangle-exclamation"></i> CRÍTICO' : '<i class="fa-solid fa-check"></i> NORMAL';
  document.getElementById('singleStatusF').className = `card-badge ${fCritica ? 'badge-alert' : 'badge-ok'}`;
  document.getElementById('singleCardF').className = `metric-box ${fCritica ? 'alert-border' : ''}`;

  if (chartIndividualInstance) {
    chartIndividualInstance.options.plugins.title.text = `Histórico Detallado - Heladera N° ${heladeraSeleccionada}`;
    chartIndividualInstance.data.labels = ordenados.map(r => new Date(r.fecha_hora).toLocaleTimeString('es-AR'));
    chartIndividualInstance.data.datasets[0].data = ordenados.map(r => extraerTemperaturasReales(r, rango).tempH);
    chartIndividualInstance.data.datasets[1].data = ordenados.map(r => extraerTemperaturasReales(r, rango).tempF);
    chartIndividualInstance.update();
  }
}

// ---------------------------------------------------------------------
// ARRANQUE VERIFICANDO SESIÓN ACTIVA
// ---------------------------------------------------------------------
verificarSesionInicial();