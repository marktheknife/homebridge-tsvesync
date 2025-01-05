import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { VeSync } from 'tsvesync';
import { DeviceFactory } from './utils/device-factory';
import { BaseAccessory } from './accessories/base.accessory';
import { PluginLogger } from './utils/logger';

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class TSVESyncPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];
  private readonly deviceAccessories: Map<string, BaseAccessory> = new Map();
  
  private client!: VeSync;
  private deviceUpdateInterval?: NodeJS.Timeout;
  private readonly updateInterval!: number;
  private readonly debug!: boolean;
  private lastLoginAttempt: Date = new Date(0);
  private loginBackoffTime = 10000; // Start with 10 seconds
  private initializationPromise: Promise<void>;
  private initializationResolver!: () => void;
  private isInitialized = false;
  private readonly logger!: PluginLogger;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    // Create initialization promise
    this.initializationPromise = new Promise((resolve) => {
      this.initializationResolver = resolve;
    });

    // Get config values with defaults
    this.updateInterval = config.updateInterval || 30;
    this.debug = config.debug || false;

    // Initialize logger
    this.logger = new PluginLogger(this.log, this.debug);

    // Validate configuration
    if (!config.username || !config.password) {
      this.logger.error('Missing required configuration. Please check your config.json');
      return;
    }

    // Initialize VeSync client with all configuration
    this.client = new VeSync(
      config.username,
      config.password,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      this.debug,
      true, // redact sensitive info
      config.apiUrl,
      this.logger
    );

    this.logger.debug('Initialized platform with config:', {
      name: config.name,
      username: config.username,
      updateInterval: this.updateInterval,
      debug: this.debug,
      apiUrl: config.apiUrl,
    });

    this.logger.info('Finished initializing platform:', this.config.name);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    this.api.on('didFinishLaunching', async () => {
      this.logger.debug('Executed didFinishLaunching callback');

      try {
        // Initialize platform
        await this.initializePlatform();
        
        // Set up device update interval
        this.deviceUpdateInterval = setInterval(() => {
          this.updateDeviceStates();
        }, this.updateInterval * 1000);
      } catch (error) {
        this.logger.error('Failed to initialize platform:', error);
        // Ensure initialization is resolved even on error
        this.isInitialized = true;
        this.initializationResolver();
      }
    });

    // Clean up when shutting down
    this.api.on('shutdown', () => {
      if (this.deviceUpdateInterval) {
        clearInterval(this.deviceUpdateInterval);
      }
    });
  }

  /**
   * Check if platform is ready
   */
  public async isReady(): Promise<void> {
    if (!this.isInitialized) {
      try {
        // Add a 30 second timeout to prevent infinite waiting
        const timeoutPromise = new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error('Platform initialization timed out')), 30000);
        });

        await Promise.race([this.initializationPromise, timeoutPromise]);
      } catch (error) {
        this.logger.error('Platform initialization failed:', error);
        // Force initialization state to true to prevent further waiting
        this.isInitialized = true;
        this.initializationResolver();
        throw error;
      }
    }
  }

  /**
   * Initialize the platform
   */
  private async initializePlatform(): Promise<void> {
    try {
      // Try to login first
      if (!await this.ensureLogin()) {
        throw new Error('Failed to login to VeSync API');
      }

      // Get devices from API
      await this.client.update();

      // Discover devices
      await this.discoverDevices();

      // Mark as initialized before initializing accessories
      this.isInitialized = true;
      this.initializationResolver();

      // Initialize all accessories
      const initPromises = Array.from(this.deviceAccessories.entries()).map(([uuid, accessory]) => {
        const deviceName = this.accessories.find(acc => acc.UUID === uuid)?.displayName || uuid;
        return accessory.initialize().catch(error => {
          this.logger.error(`Failed to initialize accessory ${deviceName}:`, error);
        });
      });
      
      await Promise.all(initPromises);
    } catch (error) {
      this.logger.error('Failed to initialize platform:', error);
      // Still resolve the promise to allow retries during polling
      this.isInitialized = true;
      this.initializationResolver();
      throw error;
    }
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.logger.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  /**
   * Get all devices from all categories
   */
  private getAllDevices() {
    return [
      ...this.client.fans,
      ...this.client.outlets,
      ...this.client.switches,
      ...this.client.bulbs,
    ];
  }

  /**
   * Create a serializable device context
   */
  private createDeviceContext(device: any) {
    return {
      cid: device.cid,
      deviceName: device.deviceName.trim(),
      deviceStatus: device.deviceStatus,
      deviceType: device.deviceType,
      deviceRegion: device.deviceRegion,
      uuid: device.uuid,
      configModule: device.configModule,
      macId: device.macId,
      deviceCategory: device.deviceCategory,
      connectionStatus: device.connectionStatus,
      details: device.details || {},
      config: device.config || {}
    };
  }

  /**
   * Ensure client is logged in, but avoid unnecessary logins
   */
  private async ensureLogin(forceLogin = false): Promise<boolean> {
    let isLoggedIn = false;
    while (!isLoggedIn) {  // Keep trying until successful
      try {
        // Check if we need to wait for backoff
        const timeSinceLastAttempt = Date.now() - this.lastLoginAttempt.getTime();
        if (timeSinceLastAttempt < this.loginBackoffTime) {
          const waitTime = this.loginBackoffTime - timeSinceLastAttempt;
          this.logger.debug(`Waiting ${waitTime}ms before next login attempt (backoff)`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }

        // Need to login again
        this.logger.debug(forceLogin ? 'Forcing new login to VeSync API' : 'Logging in to VeSync API');
        
        this.lastLoginAttempt = new Date();
        const loginResult = await this.client.login();
        
        if (!loginResult) {
          this.logger.error('Login failed - invalid credentials or API error');
          this.loginBackoffTime = Math.min(this.loginBackoffTime * 2, 300000);
          continue;  // Try again after backoff
        }
        
        // Reset backoff on successful login
        this.loginBackoffTime = 10000;
        isLoggedIn = true;
        return true;
      } catch (error) {
        // Handle specific errors
        const errorObj = error as any;
        const errorMsg = errorObj?.error?.msg || errorObj?.msg || String(error);
        
        if (errorMsg.includes('Not logged in')) {
          this.logger.debug('Session expired, forcing new login');
          this.loginBackoffTime = Math.min(this.loginBackoffTime, 5000);
          continue;  // Try again after backoff
        }
        
        // Increase backoff time exponentially, max 5 minutes
        this.loginBackoffTime = Math.min(this.loginBackoffTime * 2, 300000);
        
        this.logger.error('Login error:', error);
        continue;  // Try again after backoff
      }
    }
    return true;  // This line will never be reached but TypeScript needs it
  }

  /**
   * Update device states periodically
   */
  private async updateDeviceStates() {
    await this.discoverDevices();
  }

  /**
   * This function discovers and registers your devices as accessories
   */
  async discoverDevices() {
    this.logger.warn('Discovering devices');
    try {
      // Try to login first
      if (!await this.ensureLogin()) {
        return;
      }

      let retryCount = 0;
      let success = false;

      // Keep retrying API calls
      while (!success) {
        try {
          // Update device data from API
          await this.client.update();
          success = true;
        } catch (error) {
          retryCount++;
          const backoffTime = Math.min(10000 * Math.pow(2, retryCount), 300000);
          this.logger.warn(`API call failed, retry attempt ${retryCount}. Waiting ${backoffTime/1000} seconds...`);
          await new Promise(resolve => setTimeout(resolve, backoffTime));
          
          // Try to ensure we're still logged in before next attempt
          if (!await this.ensureLogin()) {
            continue;
          }
        }
      }

      // Get all devices
      const devices = this.getAllDevices();

      // Loop over the discovered devices and register each one
      for (const device of devices) {
        // Generate a unique id for the accessory
        const uuid = this.generateDeviceUUID(device);

        // Check if an accessory already exists
        let accessory = this.accessories.find(acc => acc.UUID === uuid);

        if (accessory) {
          // Accessory already exists
          this.logger.debug('Restoring existing accessory from cache:', device.deviceName);
          
          // Update the accessory context
          accessory.context.device = this.createDeviceContext(device);
          
          // Update accessory
          this.api.updatePlatformAccessories([accessory]);
        } else {
          // Create a new accessory
          this.logger.info('Adding new accessory:', device.deviceName);
          
          // Create the accessory
          accessory = new this.api.platformAccessory(
            device.deviceName,
            uuid,
            DeviceFactory.getAccessoryCategory(device.deviceType)
          );

          // Store device information in context
          accessory.context.device = this.createDeviceContext(device);
        }

        // Create the accessory handler
        const deviceAccessory = DeviceFactory.createAccessory(this, accessory, device);
        this.deviceAccessories.set(uuid, deviceAccessory);

        // Register new accessories
        if (!this.accessories.find(acc => acc.UUID === uuid)) {
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.accessories.push(accessory);
        }

        // Try to update device state with retries
        let stateRetryCount = 0;
        let stateSuccess = false;
        while (!stateSuccess) {
          try {
            await deviceAccessory.syncDeviceState();
            stateSuccess = true;
          } catch (error) {
            stateRetryCount++;
            const backoffTime = Math.min(5000 * Math.pow(2, stateRetryCount), 300000);
            this.logger.warn(`Failed to sync device state for ${device.deviceName}, retry attempt ${stateRetryCount}. Waiting ${backoffTime/1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, backoffTime));
            
            // Try to ensure we're still logged in before next attempt
            if (!await this.ensureLogin()) {
              continue;
            }
          }
        }
      }

      // Remove platform accessories that no longer exist
      this.accessories
        .filter(accessory => !devices.find(device => this.generateDeviceUUID(device) === accessory.UUID))
        .forEach(accessory => {
          this.logger.info('Removing existing accessory:', accessory.displayName);
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.deviceAccessories.delete(accessory.UUID);
        });

    } catch (error) {
      this.logger.error('Failed to discover devices:', error);
    }
  }

  /**
   * Generate a consistent UUID for a device
   * @param device The device to generate a UUID for
   * @returns The generated UUID string
   */
  private generateDeviceUUID(device: { cid: string; isSubDevice?: boolean; subDeviceNo?: number }): string {
    let id = device.cid;
    if (device.isSubDevice && device.subDeviceNo !== undefined) {
      id = `${device.cid}_${device.subDeviceNo}`;
    }
    return this.api.hap.uuid.generate(id);
  }
} 