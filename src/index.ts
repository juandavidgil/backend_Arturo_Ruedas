import express, { Request, Response } from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import nodemailer from 'nodemailer';
import axios from "axios";
import dotenv from "dotenv";
import { Expo } from "expo-server-sdk";
import { createClient } from '@supabase/supabase-js';
import { Resend } from "resend";
import admin from 'firebase-admin';


dotenv.config();

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_KEY!
);
const resend = new Resend(process.env.API_SEND_EMAILS);
// Guardar temporalmente los códigos de recuperación
const codigosReset = new Map();

const expo = new Expo();

interface OpenAIChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// Configuración mejorada de conexión PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Verificación mejorada de conexión
pool.connect()
.then(() => console.log("✅ Conexión exitosa a Supabase"))
.catch((err) => console.error("❌ Error al conectar a Supabase:", err));

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración mejorada de CORS y middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Middleware para manejo de errores global
app.use((err: Error, req: Request, res: Response, next: Function) => {
  console.error('⚠️ Error global:', err.stack);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// ==================== FUNCIONES DE NOTIFICACIONES ====================

/**
 * Función para guardar notificación en BD
 */
async function guardarNotificacionBD(
  ID_usuario: number, 
  titulo: string, 
  cuerpo: string, 
  data?: any
) {
  try {
    console.log(`💾 Guardando notificación para usuario ${ID_usuario}`);
    
    const result = await pool.query(
      `INSERT INTO notificaciones (ID_usuario, titulo, cuerpo, data) 
       VALUES ($1, $2, $3, $4) 
       RETURNING ID_notificacion`,
      [ID_usuario, titulo, cuerpo, data ? JSON.stringify(data) : null]
    );
    
    console.log(`✅ Notificación guardada con ID: ${result.rows[0].id_notificacion}`);
    return result.rows[0];
  } catch (error: any) {
    console.error('❌ Error guardando notificación en BD:', error);
    throw error;
  }
}

/**
 * Función para enviar notificación FCM y guardar en BD
 */
async function enviarNotificacionFCM(
  tokens: string[], 
  titulo: string, 
  cuerpo: string, 
  usuariosIds: number[],
  data?: any
) {
  try {
    if (tokens.length === 0) {
      console.log('ℹ️ No hay tokens para enviar notificación');
      return;
    }

    console.log(`📨 Enviando notificación FCM a ${tokens.length} tokens`);

    const message = {
      notification: {
        title: titulo,
        body: cuerpo
      },
      data: data || {},
      tokens: tokens
    };

    // Enviar notificación FCM
    const response = await admin.messaging().sendEachForMulticast(message);
    console.log(`✅ Notificación FCM enviada. Éxitos: ${response.successCount}, Fallos: ${response.failureCount}`);

    // Guardar notificación en BD para cada usuario
    for (const usuarioId of usuariosIds) {
      try {
        await guardarNotificacionBD(usuarioId, titulo, cuerpo, data);
      } catch (error) {
        console.error(`⚠️ Error guardando notificación para usuario ${usuarioId}:`, error);
      }
    }

    return response;

  } catch (error: any) {
    console.error('❌ Error enviando notificación FCM:', error);
    throw error;
  }
}

/**
 * Función para enviar notificaciones a través del servicio de Expo
 */
async function enviarNotificacionExpo(
  tokens: string[], 
  titulo: string, 
  cuerpo: string, 
  usuariosIds: number[],
  data?: any
) {
  try {
    if (tokens.length === 0) {
      console.log('ℹ️ No hay tokens Expo para enviar notificación');
      return;
    }

    console.log(`📨 Enviando notificación Expo a ${tokens.length} tokens`);

    // Filtrar tokens válidos de Expo
    const tokensExpoValidos = tokens.filter(token => 
      token.startsWith('ExponentPushToken') || 
      token.startsWith('https://exp.host/--/api/v2/push/')
    );

    if (tokensExpoValidos.length === 0) {
      console.log('⚠️ No hay tokens Expo válidos para enviar');
      return;
    }

    console.log(`✅ ${tokensExpoValidos.length} tokens Expo válidos encontrados`);

    // Crear mensajes para Expo
    const messages = tokensExpoValidos.map(token => ({
      to: token,
      sound: 'default',
      title: titulo,
      body: cuerpo,
      data: data || {},
      android: {
        channelId: 'default',
        priority: 'high'
      },
      ios: {
        sound: true,
        badge: 1
      }
    }));

    // Enviar notificaciones a través del servicio de Expo
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });

    const result = await response.json();
    
    if (result.errors) {
      console.error('❌ Errores en envío Expo:', result.errors);
    }

    console.log(`✅ Notificación Expo enviada. Tickets: ${result.data?.length || 0}`);

    // Guardar notificación en BD para cada usuario
    for (const usuarioId of usuariosIds) {
      try {
        await guardarNotificacionBD(usuarioId, titulo, cuerpo, data);
      } catch (error) {
        console.error(`⚠️ Error guardando notificación para usuario ${usuarioId}:`, error);
      }
    }

    return result;

  } catch (error: any) {
    console.error('❌ Error enviando notificación Expo:', error);
    throw error;
  }
}

/**
 * Función para manejar ambos tipos de tokens (FCM y Expo)
 */
async function enviarNotificacionUniversal(
  tokens: string[], 
  titulo: string, 
  cuerpo: string, 
  usuariosIds: number[],
  data?: any
) {
  try {
    if (tokens.length === 0) {
      console.log('ℹ️ No hay tokens para enviar notificación');
      return;
    }

    // Separar tokens por tipo
    const tokensExpo = tokens.filter(token => 
      token.startsWith('ExponentPushToken') || 
      token.startsWith('https://exp.host/--/api/v2/push/')
    );

    const tokensFCM = tokens.filter(token => 
      !token.startsWith('ExponentPushToken') && 
      !token.startsWith('https://exp.host/--/api/v2/push/')
    );

    console.log(`🔍 Tokens detectados - Expo: ${tokensExpo.length}, FCM: ${tokensFCM.length}`);

    const resultados = [];

    // Enviar a tokens Expo
    if (tokensExpo.length > 0) {
      console.log('🚀 Enviando a tokens Expo...');
      try {
        const resultadoExpo = await enviarNotificacionExpo(tokensExpo, titulo, cuerpo, usuariosIds, data);
        resultados.push({ plataforma: 'expo', resultado: resultadoExpo });
      } catch (error) {
        console.error('❌ Error enviando a Expo:', error);
      }
    }

    // Enviar a tokens FCM (mantener compatibilidad con apps nativas)
    if (tokensFCM.length > 0) {
      console.log('🔥 Enviando a tokens FCM nativos...');
      try {
        const resultadoFCM = await enviarNotificacionFCM(tokensFCM, titulo, cuerpo, usuariosIds, data);
        resultados.push({ plataforma: 'fcm', resultado: resultadoFCM });
      } catch (error) {
        console.error('❌ Error enviando a FCM:', error);
      }
    }

    return resultados;

  } catch (error: any) {
    console.error('❌ Error en envío universal:', error);
    throw error;
  }
}

// ==================== ENDPOINTS DE NOTIFICACIONES ====================

// 📍 ENDPOINT: Guardar token (compatible con Expo y FCM)
app.post('/guardar-token', async (req: Request, res: Response) => {
  try {
    const { ID_usuario, token, plataforma, tipo } = req.body;

    if (!ID_usuario || !token) {
      return res.status(400).json({ error: 'ID_usuario y token son requeridos' });
    }

    console.log(`🔑 Guardando token para usuario ${ID_usuario}, tipo: ${tipo || 'auto-detect'}`);

    // Verificar si el usuario existe
    const usuarioExiste = await pool.query(
      'SELECT 1 FROM usuario WHERE ID_usuario = $1',
      [ID_usuario]
    );

    if (usuarioExiste.rowCount === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Determinar tipo de token automáticamente si no se especifica
    let tipoToken = tipo;
    if (!tipoToken) {
      if (token.startsWith('ExponentPushToken') || token.startsWith('https://exp.host/--/api/v2/push/')) {
        tipoToken = 'expo';
      } else {
        tipoToken = 'fcm';
      }
    }

    console.log(`🔍 Token identificado como: ${tipoToken}`);

    // Insertar o actualizar token
    await pool.query(
      `INSERT INTO user_tokens (ID_usuario, token, tipo_token, plataforma) 
       VALUES ($1, $2, $3, $4) 
       ON CONFLICT (token) 
       DO UPDATE SET 
         ID_usuario = $1, 
         tipo_token = $3,
         plataforma = $4,
         fecha_actualizacion = CURRENT_TIMESTAMP`,
      [ID_usuario, token, tipoToken, plataforma || 'android']
    );

    console.log(`✅ Token ${tipoToken} guardado para usuario ${ID_usuario}`);
    res.json({ 
      mensaje: 'Token guardado correctamente',
      tipo: tipoToken,
      plataforma: plataforma || 'android'
    });

  } catch (error: any) {
    console.error('❌ Error guardando token:', error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// 📍 ENDPOINT: Obtener notificaciones del usuario
app.get('/notificaciones/:id_usuario', async (req: Request, res: Response) => {
  try {
    const { id_usuario } = req.params;

    console.log(`📋 Solicitando notificaciones para usuario ${id_usuario}`);

    const result = await pool.query(
      `SELECT 
        ID_notificacion,
        titulo,
        cuerpo,
        leida,
        fecha_envio,
        data
       FROM notificaciones 
       WHERE ID_usuario = $1 
       ORDER BY fecha_envio DESC 
       LIMIT 50`,
      [id_usuario]
    );

    console.log(`✅ ${result.rows.length} notificaciones encontradas`);
    res.json(result.rows);

  } catch (error: any) {
    console.error('❌ Error obteniendo notificaciones:', error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// 📍 ENDPOINT: Marcar notificación como leída
app.put('/notificaciones/:id/leida', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    console.log(`📌 Marcando notificación ${id} como leída`);

    const result = await pool.query(
      'UPDATE notificaciones SET leida = true WHERE ID_notificacion = $1 RETURNING *',
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Notificación no encontrada' });
    }

    console.log(`✅ Notificación ${id} marcada como leída`);
    res.json({ mensaje: 'Notificación marcada como leída', notificacion: result.rows[0] });

  } catch (error: any) {
    console.error('❌ Error marcando notificación como leída:', error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// 📍 ENDPOINT: Probar notificaciones FCM
app.post("/test-notification-fcm", async (req: Request, res: Response) => {
  try {
    const { ID_usuario, token } = req.body;

    if (!token || !ID_usuario) {
      return res.status(400).json({ error: "Token FCM y ID_usuario requeridos" });
    }

    console.log(`🧪 Enviando notificación de prueba a usuario ${ID_usuario}`);

    const titulo = "✅ Prueba Exitosa";
    const cuerpo = "¡Las notificaciones FCM están funcionando! 🎉";
    const data = {
      screen: 'notificaciones',
      type: 'test',
      timestamp: new Date().toISOString()
    };

    // Enviar mediante FCM
    const message = {
      notification: { title: titulo, body: cuerpo },
      data: data,
      token: token
    };

    const response = await admin.messaging().send(message);
    console.log('✅ Notificación FCM de prueba enviada');

    // Guardar en BD
    await guardarNotificacionBD(ID_usuario, titulo, cuerpo, data);

    res.json({ 
      ok: true, 
      message: "Notificación FCM enviada y guardada", 
      response 
    });
    
  } catch (error: any) {
    console.error('❌ Error enviando notificación FCM de prueba:', error);
    res.status(500).json({ 
      error: "Error enviando notificación FCM",
      details: error.message 
    });
  }
});

// 📍 ENDPOINT: Agregar al carrito (con notificación al vendedor) - ACTUALIZADO
app.post('/agregar-carrito', async (req: Request, res: Response) => {
  try {
    const { ID_usuario, ID_publicacion } = req.body;
    console.log('🛒 Agregando al carrito - Usuario:', ID_usuario, 'Publicación:', ID_publicacion);

    if (!ID_usuario || !ID_publicacion) {
      return res.status(400).json({ error: 'IDs de usuario y publicación son obligatorios' });
    }

    // Verificar existencia
    const verificacion = await pool.query(
      `SELECT 
        (SELECT 1 FROM usuario WHERE ID_usuario = $1) AS usuario_existe,
        (SELECT 1 FROM com_ventas WHERE ID_publicacion = $2) AS articulo_existe,
        (SELECT 1 FROM carrito WHERE ID_usuario = $1 AND ID_publicacion = $2) AS en_carrito`,
      [ID_usuario, ID_publicacion]
    );

    const { usuario_existe, articulo_existe, en_carrito } = verificacion.rows[0];

    if (!usuario_existe) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (!articulo_existe) return res.status(404).json({ error: 'Artículo no encontrado' });
    if (en_carrito) return res.status(409).json({ error: 'Artículo ya está en el carrito' });

    // Insertar en carrito
    await pool.query(
      'INSERT INTO carrito (ID_usuario, ID_publicacion) VALUES ($1, $2)',
      [ID_usuario, ID_publicacion]
    );

    // Obtener datos del vendedor
    const datosVendedor = await pool.query(
      `SELECT u.ID_usuario, u.nombre, cv.nombre_articulo
       FROM com_ventas cv
       JOIN usuario u ON cv.ID_usuario = u.ID_usuario
       WHERE cv.ID_publicacion = $1`,
      [ID_publicacion]
    );

    const vendedor = datosVendedor.rows[0];
    if (vendedor) {
      // Obtener tokens FCM del vendedor
      const tokensRes = await pool.query(
        "SELECT token FROM user_tokens WHERE ID_usuario = $1", 
        [vendedor.ID_usuario]
      );
      
      const tokens: string[] = tokensRes.rows.map((r: any) => r.token);
      
      if (tokens.length > 0) {
        console.log(`📨 Enviando notificación a vendedor ${vendedor.nombre}`);
        
        // USAR EL SISTEMA UNIVERSAL PARA EXPO Y FCM
        await enviarNotificacionUniversal(
          tokens,
          "¡Nuevo interés en tu artículo! 🛒",
          `Alguien agregó "${vendedor.nombre_articulo}" al carrito. Revisa tus ventas.`,
          [vendedor.ID_usuario],
          { 
            tipo: 'interes_carrito',
            ID_publicacion: ID_publicacion.toString(),
            nombre_articulo: vendedor.nombre_articulo,
            timestamp: new Date().toISOString()
          }
        );
      } else {
        console.log(`ℹ️ Vendedor ${vendedor.nombre} no tiene tokens FCM registrados`);
      }
    } 

    res.status(201).json({ mensaje: 'Artículo agregado al carrito correctamente' });
  } catch (error: any) {
    console.error('❌ Error al agregar al carrito:', error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// 📍 ENDPOINT: Marcar como vendido (con notificación a compradores) - ACTUALIZADO
app.delete('/marcar-vendido/:id', async (req: Request, res: Response) => {
  const idPublicacion = Number(req.params.id);
  
  try {
    console.log(`💰 Marcando como vendido publicación ${idPublicacion}`);

    // 1) Obtener datos de la publicación
    const pubRes = await pool.query('SELECT * FROM com_ventas WHERE ID_publicacion = $1', [idPublicacion]);
    if (pubRes.rowCount === 0) return res.status(404).json({ error: 'Publicación no encontrada' });
    const publicacion = pubRes.rows[0];

    const nombreArticulo = publicacion.nombre_articulo ?? publicacion.nombre_Articulo ?? 'Artículo';

    // 2) Obtener compradores que tenían el artículo en carrito
    const compradoresRes = await pool.query(
      `SELECT c.ID_usuario AS id_usuario, u.nombre
       FROM carrito c
       JOIN usuario u ON c.ID_usuario = u.ID_usuario
       WHERE c.ID_publicacion = $1`,
      [idPublicacion]
    );
    console.log(`👥 ${compradoresRes.rows.length} compradores encontrados`);

    // 3) Obtener tokens de esos compradores (ahora incluye Expo tokens)
    const compradoresIds = compradoresRes.rows.map((r: any) => r.id_usuario);
    
    let tokens: string[] = [];
    let compradoresConTokens: number[] = [];
    
    if (compradoresIds.length > 0) {
      const tokensRes = await pool.query(
        `SELECT ID_usuario, token FROM user_tokens WHERE ID_usuario = ANY($1::int[])`,
        [compradoresIds]
      );
      
      tokens = tokensRes.rows.map((r: any) => r.token);
      compradoresConTokens = tokensRes.rows.map((r: any) => r.ID_usuario);
      
      console.log(`📨 ${tokens.length} tokens encontrados`);
    }

    // 4) Borrar publicación y limpiar carrito
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      await client.query(
        'DELETE FROM com_ventas WHERE ID_publicacion = $1', 
        [idPublicacion]
      );
      
      await client.query(
        'DELETE FROM carrito WHERE ID_publicacion = $1', 
        [idPublicacion]
      );
      
      await client.query('COMMIT');
      console.log('🗑️ Publicación y carrito eliminados');
      
    } catch (txErr: any) {
      await client.query('ROLLBACK');
      console.error('❌ Error en transacción:', txErr);
      return res.status(500).json({ error: 'Error en transacción al eliminar publicación' });
    } finally {
      client.release();
    }

    // 5) Enviar notificaciones usando el sistema universal
    if (tokens.length > 0) {
      console.log(`🚀 Enviando notificaciones a ${tokens.length} compradores`);
      
      await enviarNotificacionUniversal(
        tokens,
        'Artículo ya no disponible ❌',
        `El artículo "${nombreArticulo}" que tenías en tu carrito ya fue vendido.`,
        compradoresConTokens,
        {
          tipo: 'articulo_vendido',
          ID_publicacion: idPublicacion.toString(),
          nombre_articulo: nombreArticulo,
          timestamp: new Date().toISOString()
        }
      );
    } else {
      console.log('ℹ️ No hay tokens para enviar notificaciones');
    }

    res.json({ 
      message: 'Publicación eliminada y compradores notificados',
      compradoresNotificados: tokens.length,
      totalCompradores: compradoresIds.length
    });
    
  } catch (err: any) {
    console.error('❌ Error en marcar-vendido:', err);
    res.status(500).json({ 
      error: 'Error en el servidor',
      details: err.message 
    });
  }
});

// 📍 ENDPOINT: Obtener información de tokens (para debugging)
app.get('/debug-tokens/:id_usuario', async (req: Request, res: Response) => {
  try {
    const { id_usuario } = req.params;

    const tokensRes = await pool.query(
      `SELECT token, tipo_token, plataforma, fecha_registro, fecha_actualizacion 
       FROM user_tokens 
       WHERE ID_usuario = $1`,
      [id_usuario]
    );

    res.json({
      usuario: id_usuario,
      total_tokens: tokensRes.rows.length,
      tokens: tokensRes.rows
    });

  } catch (error: any) {
    console.error('❌ Error obteniendo tokens:', error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// ==================== ENDPOINTS EXISTENTES (SE MANTIENEN IGUAL) ====================

// Validación de campos comunes
const validarCamposUsuario = (req: Request, res: Response, next: Function) => {
  const { nombre, correo, contraseña, telefono } = req.body;
  
  if (!nombre || !correo || !contraseña || !telefono) {
    return res.status(400).json({ error: 'Todos los campos son obligatorios' });
  }
  
  if (telefono.length !== 10 || !/^\d+$/.test(telefono)) {
    return res.status(400).json({ error: 'Teléfono debe tener 10 dígitos' });
  }
  
  next();
};

// Ruta para registrar usuario con foto en Supabase
app.post('/registrar', validarCamposUsuario, async (req: Request, res: Response) => {
  const { nombre, correo, contraseña, telefono, foto } = req.body;

  const client = await pool.connect();

  try {
    // Verificar si el usuario ya existe
    const usuarioExistente = await pool.query(
      'SELECT 1 FROM usuario WHERE correo = $1',
      [correo]
    );

    if (usuarioExistente.rows.length > 0) {
      return res.status(409).json({ error: 'El correo ya está registrado' });
    }

    await client.query('BEGIN');

    let publicUrl: string | null = null;

    if (foto) {
      // Detectar tipo real de imagen
      const match = foto.match(/^data:image\/(\w+);base64,/);
      if (!match) {
        return res.status(400).json({ error: 'Formato de imagen inválido' });
      }
      const tipo = match[1]; // 'png', 'jpeg', etc.

      // Convertir base64 a buffer
      const base64Data = foto.replace(/^data:image\/\w+;base64,/, "");
      const fotoBuffer = Buffer.from(base64Data, 'base64');

      // Generar nombre único para la foto
      const nombreArchivo = `publicaciones/${correo}_${Date.now()}.${tipo}`;

      // Subir foto al bucket 'articulos' (igual que publicar_articulo)
      const { error: uploadError } = await supabase.storage
        .from('articulos')
        .upload(nombreArchivo, fotoBuffer, {
          contentType: `image/${tipo}`,
          upsert: true,
        });

      if (uploadError) {
        console.error('Error al subir la foto:', uploadError);
        return res.status(500).json({ error: 'No se pudo subir la foto' });
      }

      // Obtener URL pública
      const { data } = supabase.storage.from('articulos').getPublicUrl(nombreArchivo);
      publicUrl = data.publicUrl;
    }

    // Insertar usuario en la base de datos con URL pública de la foto
    const result = await client.query(
      'INSERT INTO usuario (nombre, correo, contraseña, telefono, foto) VALUES ($1, $2, $3, $4, $5) RETURNING id_usuario, nombre, correo, foto',
      [nombre, correo, contraseña, telefono, publicUrl]
    );

    await client.query('COMMIT');

    res.status(201).json({ 
      mensaje: 'Usuario registrado correctamente',
      usuario: result.rows[0]
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al registrar usuario:', error);
    res.status(500).json({ error: 'Error en el servidor' });
  } finally {
    client.release();
  }
});

// Ruta para iniciar sesión - Mejorada
app.post('/iniciar-sesion', async (req: Request, res: Response) => {
  try {
    const { correo, contraseña } = req.body;
    
    if (!correo || !contraseña) {
      return res.status(400).json({ error: 'Correo y contraseña son obligatorios' });
    }

    const result = await pool.query(
      `SELECT id_usuario AS "ID_usuario", nombre, correo 
       FROM usuario 
       WHERE correo = $1 AND contraseña = $2`,
      [correo, contraseña]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    res.status(200).json({ 
      mensaje: 'Inicio de sesión exitoso',
      usuario: result.rows[0] 
    });
  } catch (error) {
    console.error('Error al iniciar sesión:', error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// ... (el resto de tus endpoints existentes se mantienen igual)
// [TODOS LOS DEMÁS ENDPOINTS QUE NO SON DE NOTIFICACIONES]

// Iniciar servidor con manejo de errores
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
}).on('error', (err) => {
  console.error('❌ Error al iniciar el servidor:', err.message);
  process.exit(1);
});

// Manejo de cierre limpio
process.on('SIGTERM', () => {
  console.log('🛑 Recibida señal SIGTERM. Cerrando servidor...');
  pool.end().then(() => {
    console.log('✅ Conexión a PostgreSQL cerrada');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 Recibida señal SIGINT. Cerrando servidor...');
  pool.end().then(() => {
    console.log('✅ Conexión a PostgreSQL cerrada');
    process.exit(0);
  });
});