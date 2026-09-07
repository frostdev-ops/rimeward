//! EIS uses only the fd granted by our RemoteDesktop portal session.
use reis::{ei, handshake::EiHandshaker, Interface, PendingRequestResult};
use std::collections::{HashMap, HashSet};
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

#[derive(Default)]
struct Device {
    interfaces: HashMap<String, reis::Object>,
    regions: Vec<Region>,
    next_mapping: Option<String>,
    resumed: bool,
    emulating: bool,
    keys: HashSet<u32>,
    buttons: HashSet<u32>,
}
struct Region {
    mapping: Option<String>,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}
impl Device {
    fn interface<T: Interface>(&self) -> Option<T> {
        self.interfaces.get(T::NAME)?.clone().downcast()
    }
}
pub struct Eis {
    context: ei::Context,
    devices: HashMap<ei::Device, Device>,
    seats: HashMap<ei::Seat, u64>,
    serial: u32,
    sequence: u32,
    began: Instant,
    pub generation: u64,
}
impl Eis {
    pub fn connect(fd: OwnedFd) -> Result<Self, String> {
        let stream = UnixStream::from(fd);
        stream.set_nonblocking(true).map_err(|e| e.to_string())?;
        let context = ei::Context::new(stream).map_err(|e| e.to_string())?;
        let mut handshake = EiHandshaker::new("Rimeward", ei::handshake::ContextType::Sender);
        let began = Instant::now();
        let serial = 'handshake: loop {
            if began.elapsed() > Duration::from_secs(2) {
                return Err("EIS handshake timed out".into());
            }
            match context.read() {
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(e) => return Err(e.to_string()),
            }
            while let Some(event) = context.pending_event() {
                let PendingRequestResult::Request(event) = event else {
                    return Err("Invalid EIS handshake".into());
                };
                if let Some(response) = handshake.handle_event(event).map_err(|e| e.to_string())? {
                    break 'handshake response.serial;
                }
            }
            context.flush().map_err(|e| e.to_string())?;
        };
        Ok(Self {
            context,
            devices: HashMap::new(),
            seats: HashMap::new(),
            serial,
            sequence: 0,
            began,
            generation: 0,
        })
    }
    pub fn refresh(&mut self) -> Result<(), String> {
        match self.context.read() {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(e) => return Err(e.to_string()),
        }
        let mut count = 0;
        while let Some(event) = self.context.pending_event() {
            count += 1;
            if count > 1024 {
                return Err("EIS event limit exceeded".into());
            }
            let PendingRequestResult::Request(event) = event else {
                return Err("Invalid EIS event".into());
            };
            match event {
                ei::Event::Connection(_, ei::connection::Event::Ping { ping }) => ping.done(0),
                ei::Event::Connection(_, ei::connection::Event::Disconnected { .. }) => {
                    return Err("Compositor disconnected input".into())
                }
                ei::Event::Connection(_, ei::connection::Event::Seat { seat }) => {
                    if self.seats.len() >= 8 {
                        return Err("Too many EIS seats".into());
                    }
                    self.seats.insert(seat, 0);
                }
                ei::Event::Seat(seat, ei::seat::Event::Capability { mask, interface }) => {
                    if [
                        "ei_keyboard",
                        "ei_pointer_absolute",
                        "ei_button",
                        "ei_scroll",
                        "ei_text",
                    ]
                    .contains(&interface.as_str())
                    {
                        *self.seats.get_mut(&seat).ok_or("Unknown EIS seat")? |= mask;
                    }
                }
                ei::Event::Seat(seat, ei::seat::Event::Done) => {
                    seat.bind(*self.seats.get(&seat).ok_or("Unknown EIS seat")?)
                }
                ei::Event::Seat(_, ei::seat::Event::Device { device }) => {
                    if self.devices.len() >= 64 {
                        return Err("Too many EIS devices".into());
                    }
                    self.devices.insert(device, Device::default());
                }
                ei::Event::Device(device, event) => {
                    if let ei::device::Event::Destroyed { serial } = event {
                        self.serial = serial;
                        self.devices.remove(&device);
                        self.generation += 1;
                        continue;
                    }
                    let data = self.devices.get_mut(&device).ok_or("Unknown EIS device")?;
                    match event {
                        ei::device::Event::Interface { object } => {
                            data.interfaces.insert(object.interface().into(), object);
                        }
                        ei::device::Event::RegionMappingId { mapping_id } => {
                            data.next_mapping = Some(mapping_id)
                        }
                        ei::device::Event::Region {
                            offset_x,
                            offset_y,
                            width,
                            hight,
                            ..
                        } => {
                            if data.regions.len() >= 64 {
                                return Err("Too many EIS regions".into());
                            }
                            data.regions.push(Region {
                                mapping: data.next_mapping.take(),
                                x: offset_x,
                                y: offset_y,
                                width,
                                height: hight,
                            });
                        }
                        ei::device::Event::Resumed { serial } => {
                            self.serial = serial;
                            data.resumed = true;
                            self.generation += 1;
                        }
                        ei::device::Event::Paused { serial } => {
                            self.serial = serial;
                            data.resumed = false;
                            data.emulating = false;
                            data.keys.clear();
                            data.buttons.clear();
                            self.generation += 1;
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        self.context.flush().map_err(|e| e.to_string())
    }
    pub fn keyboard(&self) -> bool {
        self.devices
            .values()
            .any(|d| d.resumed && d.interface::<ei::Keyboard>().is_some())
    }
    pub fn pointer_available(&self) -> bool {
        self.devices.values().any(|d| {
            d.resumed && d.interface::<ei::PointerAbsolute>().is_some() && !d.regions.is_empty()
        }) && self
            .devices
            .values()
            .any(|d| d.resumed && d.interface::<ei::Button>().is_some())
    }
    pub fn text_available(&self) -> bool {
        self.devices
            .values()
            .any(|d| d.resumed && d.interface::<ei::Text>().is_some())
    }
    fn begin(device: &ei::Device, data: &mut Device, serial: u32, sequence: &mut u32) {
        if !data.emulating {
            device.start_emulating(serial, *sequence);
            *sequence = sequence.wrapping_add(1);
            data.emulating = true;
        }
    }
    pub fn pointer(
        &mut self,
        mapping: Option<&str>,
        single_display: bool,
        x: f64,
        y: f64,
    ) -> Result<(), String> {
        if !x.is_finite() || !y.is_finite() || !(0.0..1.0).contains(&x) || !(0.0..1.0).contains(&y)
        {
            return Err("Invalid pointer coordinates".into());
        }
        self.refresh()?;
        let region_count = self
            .devices
            .values()
            .filter(|d| d.resumed)
            .map(|d| d.regions.len())
            .sum::<usize>();
        for (device, data) in &mut self.devices {
            if !data.resumed {
                continue;
            }
            let Some(pointer) = data.interface::<ei::PointerAbsolute>() else {
                continue;
            };
            let region = data.regions.iter().find(|r| match mapping {
                Some(id) => r.mapping.as_deref() == Some(id),
                None => single_display && region_count == 1,
            });
            let Some(region) = region else {
                continue;
            };
            let point = (
                region.x as f64 + x * region.width as f64,
                region.y as f64 + y * region.height as f64,
            );
            Self::begin(device, data, self.serial, &mut self.sequence);
            pointer.motion_absolute(point.0 as f32, point.1 as f32);
            device.frame(self.serial, self.began.elapsed().as_micros() as u64);
            return self.context.flush().map_err(|e| e.to_string());
        }
        Err("Compositor did not provide a matching input region for this display".into())
    }
    pub fn key(&mut self, code: u32, down: bool) -> Result<(), String> {
        self.refresh()?;
        for (device, data) in &mut self.devices {
            if !data.resumed {
                continue;
            }
            let Some(keyboard) = data.interface::<ei::Keyboard>() else {
                continue;
            };
            // The compositor handles repeat for held keys; duplicate presses are not valid EIS state changes.
            if if down {
                !data.keys.insert(code)
            } else {
                !data.keys.remove(&code)
            } {
                return Ok(());
            }
            Self::begin(device, data, self.serial, &mut self.sequence);
            keyboard.key(
                code,
                if down {
                    ei::keyboard::KeyState::Press
                } else {
                    ei::keyboard::KeyState::Released
                },
            );
            device.frame(self.serial, self.began.elapsed().as_micros() as u64);
            return self.context.flush().map_err(|e| e.to_string());
        }
        Err("Compositor keyboard input unavailable".into())
    }
    pub fn button(&mut self, code: u32, down: bool) -> Result<(), String> {
        self.refresh()?;
        for (device, data) in &mut self.devices {
            if !data.resumed {
                continue;
            }
            let Some(button) = data.interface::<ei::Button>() else {
                continue;
            };
            if if down {
                !data.buttons.insert(code)
            } else {
                !data.buttons.remove(&code)
            } {
                return Ok(());
            }
            Self::begin(device, data, self.serial, &mut self.sequence);
            button.button(
                code,
                if down {
                    ei::button::ButtonState::Press
                } else {
                    ei::button::ButtonState::Released
                },
            );
            device.frame(self.serial, self.began.elapsed().as_micros() as u64);
            return self.context.flush().map_err(|e| e.to_string());
        }
        Err("Compositor pointer buttons unavailable".into())
    }
    pub fn scroll(&mut self, x: f32, y: f32) -> Result<(), String> {
        self.refresh()?;
        for (device, data) in &mut self.devices {
            if !data.resumed {
                continue;
            }
            let Some(scroll) = data.interface::<ei::Scroll>() else {
                continue;
            };
            Self::begin(device, data, self.serial, &mut self.sequence);
            scroll.scroll(x, y);
            device.frame(self.serial, self.began.elapsed().as_micros() as u64);
            return self.context.flush().map_err(|e| e.to_string());
        }
        Err("Compositor scrolling unavailable".into())
    }
    pub fn text(&mut self, text: &str) -> Result<(), String> {
        if text.contains('\0') || text.chars().count() > 4000 {
            return Err("Invalid composed text".into());
        }
        self.refresh()?;
        for (device, data) in &mut self.devices {
            if !data.resumed {
                continue;
            }
            let Some(interface) = data.interface::<ei::Text>() else {
                continue;
            };
            Self::begin(device, data, self.serial, &mut self.sequence);
            let mut remaining = text;
            while !remaining.is_empty() {
                let mut end = remaining.len().min(254);
                while !remaining.is_char_boundary(end) {
                    end -= 1;
                }
                interface.utf8(&remaining[..end]);
                device.frame(self.serial, self.began.elapsed().as_micros() as u64);
                remaining = &remaining[end..];
            }
            return self.context.flush().map_err(|e| e.to_string());
        }
        Err(
            "This compositor has no EIS composed-text capability; use explicit clipboard exchange"
                .into(),
        )
    }
    pub fn release(&mut self) -> Result<(), String> {
        self.refresh()?;
        for (device, data) in &mut self.devices {
            if !data.resumed || !data.emulating {
                continue;
            }
            if let Some(keyboard) = data.interface::<ei::Keyboard>() {
                for key in data.keys.drain() {
                    keyboard.key(key, ei::keyboard::KeyState::Released);
                    device.frame(self.serial, self.began.elapsed().as_micros() as u64);
                }
            }
            if let Some(button) = data.interface::<ei::Button>() {
                for button_code in data.buttons.drain() {
                    button.button(button_code, ei::button::ButtonState::Released);
                    device.frame(self.serial, self.began.elapsed().as_micros() as u64);
                }
            }
            device.stop_emulating(self.serial);
            data.emulating = false;
        }
        self.context.flush().map_err(|e| e.to_string())
    }
}
impl Drop for Eis {
    fn drop(&mut self) {
        let _ = self.release();
    }
}
