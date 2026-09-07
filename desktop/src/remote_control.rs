//! Pure ownership state. The signed parent, not a viewer or media helper, owns it.
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Human,
    Rime,
}
#[derive(Clone, Debug, Serialize)]
pub struct Owner {
    pub id: String,
    pub kind: Kind,
    pub generation: u64,
    #[serde(skip)]
    deadline: u64,
    #[serde(skip)]
    sequence: u64,
}
#[derive(Default)]
pub struct Authority {
    pub owner: Option<Owner>,
    pub generation: u64,
    pub topology: u64,
}
impl Authority {
    /// A generation change requires the caller to release every held input.
    pub fn release(&mut self) {
        self.owner = None;
        self.generation += 1;
    }
    pub fn expire(&mut self, now: u64) -> bool {
        if self.owner.as_ref().is_some_and(|o| now >= o.deadline) {
            self.release();
            true
        } else {
            false
        }
    }
    pub fn topology_changed(&mut self) {
        self.topology += 1;
        self.release();
    }
    pub fn acquire(
        &mut self,
        id: &str,
        kind: Kind,
        takeover: bool,
        now: u64,
    ) -> Result<u64, String> {
        if id.is_empty() || id.len() > 160 {
            return Err("Invalid controller".into());
        }
        self.expire(now);
        if let Some(owner) = &self.owner {
            if owner.id == id && owner.kind == kind {
                return Ok(owner.generation);
            }
            if kind == Kind::Rime {
                return Err("Another controller owns this desktop. Rime cannot take over.".into());
            }
            if owner.kind == Kind::Human && !takeover {
                return Err(
                    "Another viewer controls this desktop. Select Take over explicitly.".into(),
                );
            }
        }
        self.release();
        self.owner = Some(Owner {
            id: id.into(),
            kind,
            generation: self.generation,
            deadline: now + 5000,
            sequence: 0,
        });
        Ok(self.generation)
    }
    pub fn heartbeat(&mut self, id: &str, generation: u64, now: u64) -> Result<(), String> {
        self.check(id, generation, self.topology, now)?;
        self.owner.as_mut().ok_or("Control released")?.deadline = now + 5000;
        Ok(())
    }
    pub fn check(
        &mut self,
        id: &str,
        generation: u64,
        topology: u64,
        now: u64,
    ) -> Result<(), String> {
        self.expire(now);
        if topology != self.topology
            || !self
                .owner
                .as_ref()
                .is_some_and(|o| o.id == id && o.generation == generation)
        {
            return Err(
                "Control changed or expired. Acquire control again; input was not replayed.".into(),
            );
        }
        Ok(())
    }
    pub fn input(
        &mut self,
        id: &str,
        generation: u64,
        topology: u64,
        sequence: u64,
        now: u64,
    ) -> Result<(), String> {
        self.check(id, generation, topology, now)?;
        let owner = self.owner.as_mut().ok_or("Control released")?;
        if sequence <= owner.sequence {
            return Err("Duplicate or stale input sequence".into());
        }
        // Consume before OS dispatch, including partial failures.
        owner.sequence = sequence;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn takeover_expiry_and_replay() {
        let mut a = Authority::default();
        let rime = a.acquire("agent", Kind::Rime, false, 100).unwrap();
        let human = a.acquire("viewer", Kind::Human, false, 101).unwrap();
        assert!(a.check("agent", rime, 0, 102).is_err());
        assert!(a.acquire("agent", Kind::Rime, true, 102).is_err());
        assert!(a.acquire("other", Kind::Human, false, 102).is_err());
        assert!(a.input("viewer", human, 0, 1, 103).is_ok());
        assert!(a.input("viewer", human, 0, 1, 104).is_err());
        assert!(a.input("viewer", human, 1, 2, 104).is_err());
        assert!(a.check("viewer", human, 0, 5101).is_err());
        assert!(a.heartbeat("viewer", human, 5102).is_err());
        assert!(a.owner.is_none());
        let new = a.acquire("viewer", Kind::Human, false, 5103).unwrap();
        assert_ne!(human, new);
        a.topology_changed();
        assert!(a.check("viewer", new, 0, 5104).is_err());
    }
    #[test]
    fn explicit_human_takeover_and_heartbeat() {
        let mut a = Authority::default();
        let old = a.acquire("one", Kind::Human, false, 0).unwrap();
        assert!(a.heartbeat("one", old, 4000).is_ok());
        assert!(a.check("one", old, 0, 8000).is_ok());
        let new = a.acquire("two", Kind::Human, true, 8001).unwrap();
        assert!(a.input("one", old, 0, 2, 8002).is_err());
        assert!(a.input("two", new, 0, 1, 8002).is_ok());
        a.release();
        assert!(a.check("two", new, 0, 8003).is_err());
    }
}
