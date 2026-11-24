# OTP delivery retry

If an external OTP provider rejects a send or times out, the service removes the newly-created pending OTP record and returns a temporary-unavailable response. This allows a customer to request another code without waiting through a cooldown for a message that was not accepted.
