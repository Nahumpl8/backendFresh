import axios from 'axios';

const api = axios.create({
  baseURL: 'https://backendfresh-production.up.railway.app/api',
});

// ============= PRODUCTS =============
export const ProductService = {
  getAll: async () => {
    try {
      const res = await api.get('/products');
      return res.data;
    } catch (error) {
      console.error("Error cargando productos", error);
      return [];
    }
  }
};

// ============= DESPENSAS =============
export const DespensasService = {
  getAll: async () => {
    try {
      const res = await api.get('/despensas');
      return res.data.filter(d => d.showInWeb === true);
    } catch (error) {
      console.error("Error cargando despensas", error);
      return [];
    }
  }
};

// ============= CLIENT AUTH =============
export const ClientAuthService = {
  // Check if client exists by phone
  buscar: async (telefono) => {
    try {
      const res = await api.post('/clientes/buscar', { telefono });
      return { success: true, cliente: res.data };
    } catch (error) {
      if (error.response?.status === 404) {
        return { success: false, error: 'Cliente no encontrado' };
      }
      throw error;
    }
  },

  // Register new client
  register: async (clienteData) => {
    try {
      const res = await api.post('/clientes/new', clienteData);
      return { success: true, cliente: res.data };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.error || 'Error al registrar cliente'
      };
    }
  },

  // Setup PIN for first time
  setupPin: async (telefono, pin, email) => {
    try {
      const res = await api.post('/clientes-auth/setup-pin', { telefono, pin, email });
      return res.data;
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.error || 'Error al configurar PIN'
      };
    }
  },

  // Login with phone or email + PIN
  login: async (credentials) => {
    try {
      const res = await api.post('/clientes-auth/login', credentials);
      return res.data;
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.error || 'Error al iniciar sesión'
      };
    }
  },

  // Forgot PIN
  forgotPin: async (telefono, email) => {
    try {
      const res = await api.post('/clientes-auth/forgot-pin', { telefono, email });
      return res.data;
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.error || 'Error al recuperar PIN'
      };
    }
  },

  // Get client profile with orders
  getProfile: async (telefono) => {
    try {
      const res = await api.get(`/clientes/detalle/${telefono}`);
      return { success: true, ...res.data };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.error || 'Error al obtener perfil'
      };
    }
  },

  // Update client profile
  updateProfile: async (clienteId, data) => {
    try {
      const res = await api.put(`/clientes/edit/${clienteId}`, data);
      return { success: true, cliente: res.data };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.error || 'Error al actualizar perfil'
      };
    }
  },

  // Add new address
  addAddress: async (clienteId, addressData) => {
    try {
      const res = await api.put(`/clientes/add-address/${clienteId}`, addressData);
      return { success: true, cliente: res.data };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.error || 'Error al agregar dirección'
      };
    }
  }
};

// ============= PEDIDOS =============
export const PedidoService = {
  create: async (pedidoData) => {
    try {
      const res = await api.post('/pedidos/new', pedidoData);
      return { success: true, ...res.data };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.error || 'Error al crear pedido'
      };
    }
  },

  getByPhone: async (telefono) => {
    try {
      const res = await api.get(`/pedidos/cliente/${telefono}`);
      return res.data;
    } catch (error) {
      console.error("Error cargando pedidos", error);
      return [];
    }
  }
};

// ============= WALLET =============
export const WalletService = {
  /**
   * Construye la URL de descarga basada en las rutas de tu backend:
   * Apple: /api/wallet/download/apple/:id
   * Google: /api/wallet/google/:id
   */
  generarPase: async (clienteId, platform) => {
    // URL base de tu backend
    const BASE_URL = 'https://backendfresh-production.up.railway.app/api/wallet';

    let url = '';

    if (platform === 'apple') {
      // Ruta definida en línea 145 de tu backend
      url = `${BASE_URL}/download/apple/${clienteId}`;
    } else {
      // Ruta definida en línea 154 de tu backend
      url = `${BASE_URL}/google/${clienteId}`;
    }

    // Retornamos la URL lista para que el navegador la abra
    return { url };
  }
};

export default api;