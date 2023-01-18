/*
 * Copyright (c) 2023 Moddable Tech, Inc.
 *
 *   This file is part of the Moddable SDK Runtime.
 * 
 *   The Moddable SDK Runtime is free software: you can redistribute it and/or modify
 *   it under the terms of the GNU Lesser General Public License as published by
 *   the Free Software Foundation, either version 3 of the License, or
 *   (at your option) any later version.
 * 
 *   The Moddable SDK Runtime is distributed in the hope that it will be useful,
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *   GNU Lesser General Public License for more details.
 * 
 *   You should have received a copy of the GNU Lesser General Public License
 *   along with the Moddable SDK Runtime.  If not, see <http://www.gnu.org/licenses/>.
 *
 */
/*
    Broadcom APDS-9960 Proximity, Ambient Light, RGB, and Gesture Sensor
    Driver currently supports only Ambient Light
    Datasheet: https://docs.broadcom.com/docs/AV02-4191EN
*/

const Register = Object.freeze({
  AILTL: 0x84,
  AIHTL: 0x86,
  PERS: 0x8C,
  ENABLE: 0x80,
  ATIME: 0x81,
  WTIME: 0x83,
  CONTROLONE: 0x8F,
  ID: 0x92,
  STATUS: 0x93,
  CDATAL: 0x94,
  CDATAH: 0x95
});

class Sensor {
  #io;
  #monitor;
  #onAlert;
  #alsBlock;
  #alsView;
  #maxCount = 1025;

  #configuration = {
    enabled: {
      GEN: false,
      PIEN: false,
      AIEN: false,
      WEN: false,
      PEN: false,
      AEN: false,
      PON: false
    },
    alsIntegrationCycles: 1,
    alsGain: 1,
    proximityGain: 1
  }

  constructor(options){
    this.#io = new options.sensor.io({
      hz: 400_000,
      address: 0x39,
      ...options.sensor
    });

    // Reset
    try {
      this.#io.writeUint8(Register.ENABLE, 0x00);
      this.#io.writeUint8(Register.ENABLE, 0x01);
    } catch {
      this.close();
      throw new Error("reset failed");
    }

    let idCheck = false;

    try {
      idCheck = (0xAB === this.#io.readUint8(Register.ID));
    } catch {
      this.close();
      throw new Error("i2c error during id check");
    }

    if (!idCheck) {
      this.close();
      throw new Error("unexpected sensor ID");
    }

    const {alert, onAlert} = options;
    if (alert !== undefined && onAlert !== undefined) {
      this.#onAlert = onAlert;
      this.#monitor = new options.alert.io({
        mode: alert.io.InputPullUp,
        edge: alert.io.Falling,
        ...alert,
        onReadable: () => {
          this.#io.readUint8(0xE7); // have to do a fake read to clear the interrupt
          this.#onAlert();
        }
      })
    }

    this.#alsBlock = new ArrayBuffer(8);
    this.#alsView = new DataView(this.#alsBlock);

    this.configure({
      on: true,
      enableALS: true,
      alsIntegrationCycles: 10,
      alsGain: 1,
      alsThresholdLow: 0,
      alsThresholdHigh: 0xFFFF,
      alsThresholdPersistence: 1,
      proximityThresholdPersistence: 1
    });
  }
  
  configure(options){
    const {enableALS, on, alsIntegrationCycles, alsGain, proximityGain, alsThresholdHigh, alsThresholdLow, alsThresholdPersistence, proximityThresholdPersistence} = options;
    const configuration = this.#configuration;
    const enabled = this.#configuration.enabled
    const io = this.#io;
    
    if (enableALS !== undefined) {
      configuration.enabled.AEN = enableALS;
    }

    if (on !== undefined) {
      configuration.enabled.PON = on;
    }

    if (alsGain !== undefined) {
      configuration.alsGain = alsGain;
    }

    if (proximityGain !== undefined) {
      configuration.proximityGain = proximityGain;
    }

    if (alsGain !== undefined || proximityGain !== undefined) {
      let regValue = 0;
      let fieldValue = 0;

      switch (configuration.alsGain) {
        case 1:
          fieldValue = 0b00;
          break;
        case 4:
          fieldValue = 0b01;
          break;
        case 16:
          fieldValue = 0b10;
          break;
        case 64:
          fieldValue = 0b11;
          break;
        default:
          throw new Error("invalid alsGain setting");
      }
      regValue |= fieldValue;

      switch (configuration.proximityGain) {
        case 1: 
          fieldValue = 0b0000;
          break;
        case 2:
          fieldValue = 0b0100;
          break;
        case 4:
          fieldValue = 0b1000;
          break;
        case 8:
          fieldValue = 0b1100;
          break;
        default:
          throw new Error("invalid proximityGain setting");
      }
      regValue |= fieldValue;

      io.writeUint8(Register.CONTROLONE, regValue);
    }

    if (alsIntegrationCycles !== undefined) {
      if (alsIntegrationCycles > 256 || alsIntegrationCycles < 0)
        throw new Error("invalid alsIntegrationCycles setting");

      configuration.alsIntegrationCycles = alsIntegrationCycles;
      const regValue = 256 - alsIntegrationCycles;
      this.#maxCount = 1025 * alsIntegrationCycles;
      io.writeUint8(Register.ATIME, regValue);
    }


    // Alert Thresholds
    if (alsThresholdLow !== undefined) {
      if (alsThresholdLow < 0 || alsThresholdLow > 0xFFFF)
        throw new RangeError("invalid alsThresholdLow");
      configuration.alsThresholdLow = alsThresholdLow;
      io.writeUint16(Register.AILTL, alsThresholdLow);
    }

    if (alsThresholdHigh !== undefined) {
      if (alsThresholdHigh < 0 || alsThresholdHigh > 0xFFFF)
        throw new RangeError("invalid thresholdHigh");
      configuration.alsThresholdHigh = alsThresholdHigh;
      io.writeUint16(Register.AIHTL, alsThresholdHigh);
    }

    if (proximityThresholdPersistence !== undefined || alsThresholdPersistence !== undefined) {
      let APERS, PPERS;
      if (alsThresholdPersistence !== undefined) {
        APERS = apersFromCycles(alsThresholdPersistence);
        if (APERS === undefined)
          throw new RangeError("invalid alsThresholdPersistence");
        configuration.alsThresholdPersistence = alsThresholdPersistence;
      } else {
        APERS = apersFromCycles(configuration.alsThresholdPersistence);
      }

      if (proximityThresholdPersistence !== undefined) {
        if (proximityThresholdPersistence < 0 || proximityThresholdPersistence > 15)
          throw new RangeError("invalid proximityThresholdPersistence");
        configuration.proximityThresholdPersistence = proximityThresholdPersistence;
      }
      PPERS = configuration.proximityThresholdPersistence << 4;

      io.writeUint8(Register.PERS, (PPERS | APERS));
    }

    if (alsThresholdLow !== undefined || alsThresholdHigh !== undefined) {      
      if (configuration.alsThresholdHigh === 0xFFFF && configuration.alsThresholdLow === 0) {
        configuration.enabled.AIEN = false;
      } else {
        configuration.enabled.AIEN = true;
      }
      this.#io.readUint8(0xE7); // clear interrupts
    }

    if (on !== undefined || enableALS !== undefined || alsThresholdLow !== undefined || alsThresholdHigh !== undefined) {
      let e = 0;

      if (enabled.GEN)
        e |= 0b01000000;

      if (enabled.PIEN)
        e |= 0b00100000;

      if (enabled.AIEN)
        e |= 0b00010000;

      if (enabled.WEN)
        e |= 0b00001000;

      if (enabled.PEN)
        e |= 0b00000100;

      if (enabled.AEN)
        e |= 0b00000010;

      if (enabled.PON)
        e |= 0b00000001;

      io.writeUint8(Register.ENABLE, e);
    }
  }

  sample(){
    const configuration = this.#configuration;
    const enabled = configuration.enabled;
    const io = this.#io;

    if (!enabled.PON)
      return undefined;

    const status = io.readUint8(Register.STATUS);

    let result = {};

    if (enabled.AEN && status & 0x01) {
      this.#io.readBuffer(Register.CDATAL, this.#alsBlock);
      trace(`Clear: ${this.#alsView.getUint16(0, true)}\n`);

      // APDS-9960 datasheet offers no guidance on converting from raw values to Lux, so Lux is not provided in this driver's sample.
      // Values are instead [0,1] from darkness to max saturation, based on current settings.
      result.lightmeter = {
        clear: this.#alsView.getUint16(0, true) / this.#maxCount,
        red: this.#alsView.getUint16(2, true) / this.#maxCount,
        green: this.#alsView.getUint16(4, true) / this.#maxCount,
        blue: this.#alsView.getUint16(6, true) / this.#maxCount
      }
    }

    return result;
  }

  close() {
    if (this.#io) {
      this.#io.writeUint8(Register.ENABLE, 0x00);
      this.#io.close();
    }
    this.#monitor?.close();
    this.#monitor = this.#io = undefined;
  }

  get configuration() {
    return { ...this.#configuration};
  }

  get identification() {
    return {
      model: "Broadcom APDS-9960",
      classification: "AmbientLight-Gesture-Proximity"
    }
  }
}

function apersFromCycles(cycles) {
  if (cycles < 0 || cycles > 60)
    return;

  if (cycles > 3 && ((cycles % 5) !== 0))
    return;

  if (cycles <= 3)
    return cycles;

  return (cycles / 5) + 3;
}

export default Sensor;
